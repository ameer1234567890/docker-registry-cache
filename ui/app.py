#!/usr/bin/env python3
"""Web UI for a set of Docker registry pull-through caches.

* Reads the registries' on-disk storage (docker/registry/v2/...) directly. In proxy mode the
  registry's tag API asks the upstream, which says nothing about what is cached locally.
* Ingests nginx's JSON access log to learn which client requested what, and why a layer that a
  manifest lists is not cached.
* Can delete images, whole registries, or everything. A pull-through registry refuses API deletes,
  so files are removed directly and unreferenced blobs are swept.

Standard library only.
"""
import bisect
import hmac
import json
import mimetypes
import os
import re
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

DATA_DIR = os.environ.get("DATA_DIR", "/data")
PUBLIC_CERT_DIR = os.environ.get("PUBLIC_CERT_DIR", "/run/public-certs")
STATIC_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"))
STATE_DIR = os.environ.get("STATE_DIR", os.path.join(DATA_DIR, ".registry-cache"))
ACCESS_LOG = os.environ.get("ACCESS_LOG", os.path.join(STATE_DIR, "access.log"))
CLIENTS_FILE = os.environ.get("CLIENTS_FILE", "/etc/registry-cache/clients.conf")
CACHE_TTL = os.environ.get("CACHE_TTL", "")
SCAN_TTL = int(os.environ.get("SCAN_TTL", "30"))
PORT = int(os.environ.get("PORT", "8080"))
ALLOW_DELETE = os.environ.get("UI_ALLOW_DELETE", "true").strip().lower() not in ("0", "false", "no", "off")
ADMIN_TOKEN = os.environ.get("UI_ADMIN_TOKEN", "")
LOG_MAX_BYTES = int(os.environ.get("ACCESS_LOG_MAX_MB", "20")) * 1024 * 1024

MAX_JSON_BYTES = 4 * 1024 * 1024
INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
HEX64 = re.compile(r"^[0-9a-f]{64}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
TAG_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
_SEG = r"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*"
REPO_RE = re.compile(rf"^{_SEG}(?:/{_SEG})*$")
LOG_URI = re.compile(r"^/v2/(.+)/(manifests|blobs)/([^/?#]+)")


class NotFound(Exception):
    pass


# --------------------------------------------------------------------------- config
def parse_registries():
    """REGISTRIES = lines of `id|name|hostname`; unknown folders in DATA_DIR are added.

    The hostname is what clients type (ghcr.io), so it doubles as the registry's endpoint.
    """
    regs = []
    for line in os.environ.get("REGISTRIES", "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        parts += [""] * (3 - len(parts))
        rid, name, upstream = parts[:3]
        if rid:
            regs.append({"id": rid, "name": name or rid, "upstream": upstream, "endpoint": upstream or None})
    known = {r["id"] for r in regs}
    try:
        for entry in sorted(os.listdir(DATA_DIR)):
            if entry not in known and not entry.startswith(".") \
                    and os.path.isdir(os.path.join(DATA_DIR, entry)):
                regs.append({"id": entry, "name": entry, "upstream": "", "endpoint": None})
    except OSError:
        pass
    return regs


def load_client_names():
    """clients.conf: `ip|friendly name` per line."""
    names = {}
    try:
        with open(CLIENTS_FILE, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "|" in line:
                    ip, _, name = line.partition("|")
                    if ip.strip() and name.strip():
                        names[ip.strip()] = name.strip()
    except OSError:
        pass
    return names


# --------------------------------------------------------------------------- tracking
class Tracker:
    """Aggregates nginx's JSON access log: who requested which manifest, and which blob fetches failed."""

    SLACK = 120          # seconds of tolerance between a request and the manifest being stored
    COALESCE = 10        # one pull sends several requests; same client within 10 s counts once
    HEAD_KEEP = 20
    MAX_EVENTS = 2000
    MAX_BLOB_RECORDS = 100000

    def __init__(self, state_dir, log_path, host_to_id):
        self.dir, self.log_path, self.host_to_id = state_dir, log_path, host_to_id
        self.path = os.path.join(state_dir, "tracking.json")
        self.lock = threading.Lock()
        self.dirty = False
        self.last_save = 0.0
        self.state = {"v": 1, "since": time.time(), "offset": 0, "inode": 0,
                      "refs": {}, "blobs": {}, "uas": {}}
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                loaded = json.load(fh)
            if isinstance(loaded, dict) and loaded.get("v") == 1:
                self.state.update(loaded)
        except (OSError, ValueError):
            pass

    @property
    def enabled(self):
        return os.path.exists(self.log_path)

    @property
    def since(self):
        return self.state.get("since")

    # ---- ingestion
    def poll(self):
        try:
            st = os.stat(self.log_path)
        except OSError:
            return
        with self.lock:
            if st.st_ino != self.state["inode"] or st.st_size < self.state["offset"]:
                self.state["offset"], self.state["inode"] = 0, st.st_ino
            while self.state["offset"] < st.st_size:
                with open(self.log_path, "rb") as fh:
                    fh.seek(self.state["offset"])
                    data = fh.read(min(st.st_size - self.state["offset"], 8 * 1024 * 1024))
                end = data.rfind(b"\n")
                if end < 0:
                    break                       # only a partial line so far
                for line in data[:end + 1].splitlines():
                    try:
                        self._ingest(json.loads(line))
                    except (ValueError, KeyError, TypeError):
                        continue
                self.state["offset"] += end + 1
                self.dirty = True
            # Everything is ingested, so the log can be emptied once it grows large.
            if st.st_size > LOG_MAX_BYTES and self.state["offset"] >= st.st_size:
                try:
                    if os.stat(self.log_path).st_size == st.st_size:
                        os.truncate(self.log_path, 0)
                        self.state["offset"] = 0
                except OSError:
                    pass

    def _ingest(self, o):
        regid = self.host_to_id.get(o.get("h"))
        match = LOG_URI.match(o.get("u") or "")
        if not regid or not match:
            return
        repo, kind, ref = match.groups()
        method = o.get("m")
        if method not in ("GET", "HEAD") or not REPO_RE.match(repo):
            return
        status, t, ip = int(o.get("s") or 0), float(o["t"]), str(o.get("ip") or "")
        ua = (o.get("ua") or "")[:120]
        if ua and ip:
            uas = self.state["uas"]
            uas[ip] = ua
            if len(uas) > 2000:
                uas.pop(next(iter(uas)))
        if self.state["since"] is None or t < self.state["since"]:
            self.state["since"] = t
        is_digest = bool(DIGEST_RE.match(ref))
        if kind == "manifests":
            if status == 200:
                if method == "GET" and is_digest:
                    self._ok(regid, ref, t)
                self._event(regid, repo, ref, t, ip)
            elif method == "GET" and is_digest:
                self._fail(regid, ref, status, t, ip)
        elif is_digest and method == "GET":
            if status in (200, 206):
                self._ok(regid, ref, t)
            elif status >= 400:
                self._fail(regid, ref, status, t, ip)

    def _event(self, regid, repo, ref, t, ip):
        evs = self.state["refs"].setdefault(regid, {}).setdefault(repo, {}).setdefault(ref, [])
        if evs and evs[-1][1] == ip and t - evs[-1][0] <= self.COALESCE:
            return
        evs.append([round(t, 1), ip])
        if len(evs) > self.MAX_EVENTS:
            del evs[self.HEAD_KEEP:len(evs) - (self.MAX_EVENTS - self.HEAD_KEEP)]

    def _blob_rec(self, regid, digest):
        recs = self.state["blobs"].setdefault(regid, {})
        if digest not in recs and len(recs) >= self.MAX_BLOB_RECORDS:
            recs.pop(next(iter(recs)))
        return recs.setdefault(digest, {})

    def _ok(self, regid, digest, t):
        rec = self._blob_rec(regid, digest)
        rec["ok"] = min(rec.get("ok", t), round(t))
        fail = rec.get("fail")
        if fail and t >= fail[1]:
            rec.pop("fail")

    def _fail(self, regid, digest, status, t, ip):
        self._blob_rec(regid, digest)["fail"] = [status, round(t), ip]

    # ---- persistence
    def save(self, force=False):
        with self.lock:
            if not self.dirty or (not force and time.time() - self.last_save < 10):
                return
            payload = json.dumps(self.state, separators=(",", ":"))
            self.dirty = False
            self.last_save = time.time()
        try:
            os.makedirs(self.dir, exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(payload)
            os.replace(tmp, self.path)
        except OSError:
            with self.lock:
                self.dirty = True

    # ---- queries
    def blob_info(self, regid, digest):
        with self.lock:
            rec = self.state["blobs"].get(regid, {}).get(digest)
            return dict(rec) if rec else None

    def activity(self, regid, repo, tag, digest, cached_at, names):
        """Initial requester and later pulls for the current copy of a tag."""
        with self.lock:
            refs = self.state["refs"].get(regid, {}).get(repo, {})
            own = list(refs.get(tag, []))
            by_digest = list(refs.get(digest, []))
            # When a client pulls tag X, it follows up with a request for X's digest. That follow-up belongs
            # to X's pull, not to every other tag that happens to share the digest.
            tag_times = {}
            for ref, lst in refs.items():
                if not DIGEST_RE.match(ref):
                    for t, ip in lst:
                        tag_times.setdefault(ip, []).append(t)
            uas = dict(self.state["uas"])
        for times in tag_times.values():
            times.sort()

        def follows_a_tag_pull(t, ip):
            times = tag_times.get(ip, ())
            i = bisect.bisect_left(times, t - self.COALESCE)
            return i < len(times) and times[i] <= t + self.COALESCE

        # A pull by digest alone (a pinned Kubernetes image, say) is not preceded by any tag request.
        evs = own + [e for e in by_digest if not follows_a_tag_pull(e[0], e[1])]
        empty = {"initial": None, "later": [], "later_total": 0}
        if not evs:
            return empty
        evs.sort(key=lambda e: e[0])
        merged = []
        for t, ip in evs:                       # a tag request and the digest request that follows it are one pull
            if merged and merged[-1][1] == ip and t - merged[-1][0] <= self.COALESCE:
                continue
            merged.append([t, ip])
        # Only requests since the current copy was stored belong to it (older ones saw a previous copy).
        gen = [e for e in merged if e[0] >= cached_at - self.SLACK]
        if not gen:
            return empty

        def who(ip):
            return {"ip": ip, "name": names.get(ip), "ua": (uas.get(ip) or "").split(" ")[0] or None}

        initial = None
        later = gen
        if gen[0][0] <= cached_at + self.SLACK:        # otherwise the first request was never logged
            initial = dict(who(gen[0][1]), t=gen[0][0])
            later = gen[1:]
        hosts = {}
        for t, ip in later:
            h = hosts.setdefault(ip, dict(who(ip), n=0, first=t, last=t))
            h["n"] += 1
            h["last"] = max(h["last"], t)
        return {"initial": initial,
                "later": sorted(hosts.values(), key=lambda h: h["last"], reverse=True),
                "later_total": len(later)}

    def forget(self, regid=None, repo=None, tags=None, digests=None, blobs=None):
        with self.lock:
            if regid is None:
                self.state["refs"], self.state["blobs"] = {}, {}
            elif repo is None:
                self.state["refs"].pop(regid, None)
                self.state["blobs"].pop(regid, None)
            else:
                repo_refs = self.state["refs"].get(regid, {})
                if tags is None:
                    repo_refs.pop(repo, None)
                else:
                    for ref in list(tags) + list(digests or ()):
                        repo_refs.get(repo, {}).pop(ref, None)
                recs = self.state["blobs"].get(regid, {})
                for d in blobs or ():
                    recs.pop(d, None)
            self.dirty = True
        self.save(force=True)


TRACKER = None


# --------------------------------------------------------------------------- storage
class Store:
    """Accessor for one registry's `docker/registry/v2` tree."""

    def __init__(self, root):
        self.root = root
        self.blob_root = os.path.join(root, "blobs", "sha256")
        self.repo_root = os.path.join(root, "repositories")
        self._sizes = {}

    # ---- blobs
    def blob_path(self, digest):
        algo, _, hexd = (digest or "").partition(":")
        if algo != "sha256" or not HEX64.match(hexd):
            return None
        return os.path.join(self.blob_root, hexd[:2], hexd, "data")

    def size(self, digest):
        """On-disk size of a blob, or None if it is not cached."""
        if digest in self._sizes:
            return self._sizes[digest]
        path = self.blob_path(digest)
        try:
            size = os.stat(path).st_size if path else None
        except OSError:
            size = None
        self._sizes[digest] = size
        return size

    def read_json(self, digest):
        path = self.blob_path(digest)
        if not path:
            return None
        try:
            if os.stat(path).st_size > MAX_JSON_BYTES:
                return None
            with open(path, "rb") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else None
        except (OSError, ValueError):
            return None

    def total_blob_bytes(self):
        total = count = 0
        try:
            with os.scandir(self.blob_root) as top:
                for shard in top:
                    if not shard.is_dir():
                        continue
                    with os.scandir(shard.path) as inner:
                        for blob in inner:
                            try:
                                total += os.stat(os.path.join(blob.path, "data")).st_size
                                count += 1
                            except OSError:
                                pass
        except OSError:
            pass
        return total, count

    def remove_blob(self, digest):
        """Delete one blob. Returns (existed, bytes_freed)."""
        path = self.blob_path(digest)
        if not path:
            return False, 0
        try:
            freed = os.stat(path).st_size
        except OSError:
            return False, 0
        folder = os.path.dirname(path)
        shutil.rmtree(folder, ignore_errors=True)
        try:
            os.rmdir(os.path.dirname(folder))        # the two-character shard folder, if now empty
        except OSError:
            pass
        self._sizes.pop(digest, None)
        return True, freed

    # ---- repositories
    def repo_path(self, repo):
        if not REPO_RE.match(repo or ""):
            raise ValueError(f"invalid repository name {repo!r}")
        path = os.path.join(self.repo_root, repo)
        base = os.path.realpath(self.repo_root)
        if not os.path.realpath(path).startswith(base + os.sep):
            raise ValueError("repository path escapes the registry")
        return path

    def repositories(self):
        names = []
        for dirpath, dirnames, _ in os.walk(self.repo_root):
            if "_manifests" in dirnames:
                names.append(os.path.relpath(dirpath, self.repo_root))
            # Keep walking for nested repositories, but never into registry metadata.
            dirnames[:] = [d for d in dirnames if not d.startswith("_")]
        return sorted(n for n in names if n != ".")

    def tags(self, repo):
        tag_dir = os.path.join(self.repo_root, repo, "_manifests", "tags")
        try:
            names = sorted(os.listdir(tag_dir))
        except OSError:
            return
        for name in names:
            link = os.path.join(tag_dir, name, "current", "link")
            try:
                with open(link, "r") as fh:
                    digest = fh.read().strip()
                yield name, digest, os.stat(link).st_mtime
            except OSError:
                continue

    def _link_digests(self, repo, *parts):
        try:
            names = os.listdir(os.path.join(self.repo_root, repo, *parts, "sha256"))
        except OSError:
            return []
        return ["sha256:" + n for n in names if HEX64.match(n)]

    def revision_digests(self, repo):
        return self._link_digests(repo, "_manifests", "revisions")

    def layer_digests(self, repo):
        return self._link_digests(repo, "_layers")

    def uploads_active(self, repo, window=900):
        """True if a blob download into this repository started recently."""
        base = os.path.join(self.repo_root, repo, "_uploads")
        now = time.time()
        try:
            for entry in os.scandir(base):
                for p in (entry.path, os.path.join(entry.path, "data")):
                    try:
                        if now - os.stat(p).st_mtime < window:
                            return True
                    except OSError:
                        pass
        except OSError:
            pass
        return False

    # ---- reference graph
    def closure(self, digest, memo, depth=0):
        """(manifest digests, blob digests) a manifest depends on, whether or not they are cached."""
        if digest in memo:
            return memo[digest]
        manifests, blobs = {digest}, set()
        manifest = self.read_json(digest)
        if manifest is not None and depth < 4:
            if "manifests" in manifest or manifest.get("mediaType") in INDEX_TYPES:
                for child in manifest.get("manifests") or []:
                    cd = child.get("digest") if isinstance(child, dict) else None
                    if cd:
                        cm, cb = self.closure(cd, memo, depth + 1)
                        manifests |= cm
                        blobs |= cb
            else:
                blobs.update(d for _, d, _ in image_entries(manifest))
        memo[digest] = (manifests, blobs)
        return memo[digest]

    def protected_digests(self, memo):
        """Every blob and manifest still reachable from any repository of this registry."""
        protected = set()
        for repo in self.repositories():
            protected.update(self.layer_digests(repo))
            for d in self.revision_digests(repo):
                m, b = self.closure(d, memo)
                protected |= m | b
        return protected

    def prune_repo(self, repo):
        """Remove the registry bookkeeping of a repository that has nothing left in it."""
        try:
            rp = self.repo_path(repo)
        except ValueError:
            return
        if any(True for _ in self.tags(repo)) or self.revision_digests(repo):
            return
        for sub in ("_manifests", "_layers", "_uploads"):
            shutil.rmtree(os.path.join(rp, sub), ignore_errors=True)
        base = os.path.realpath(self.repo_root)
        cur = rp
        while os.path.realpath(cur) != base:        # also drop parent folders left empty
            try:
                os.rmdir(cur)
            except OSError:
                break
            cur = os.path.dirname(cur)


# --------------------------------------------------------------------------- analysis
def image_entries(manifest):
    """(kind, digest, entry) for the config and every layer of a single-image manifest."""
    out = []
    config = manifest.get("config")
    if isinstance(config, dict) and config.get("digest"):
        out.append(("config", config["digest"], config))
    for layer in manifest.get("layers") or []:
        if isinstance(layer, dict) and layer.get("digest"):
            out.append(("layer", layer["digest"], layer))
    for layer in manifest.get("fsLayers") or []:          # legacy schema 1
        if isinstance(layer, dict) and layer.get("blobSum"):
            out.append(("layer", layer["blobSum"], {}))
    return out


def is_foreign(entry):
    media = (entry.get("mediaType") or "").lower()
    return bool(entry.get("urls")) or "foreign" in media or "nondistributable" in media


def platform_label(entry):
    plat = entry.get("platform") or {}
    label = "/".join(p for p in (plat.get("os"), plat.get("architecture"), plat.get("variant")) if p)
    return label or "unknown"


class ScanContext:
    """What the scan needs besides the files: tracking history and whether a download is running."""

    def __init__(self, regid, tracker):
        self.regid, self.tracker = regid, tracker
        self.downloading = False

    def reason(self, digest, entry=None):
        """Why an item the manifest lists is not on disk."""
        if entry and is_foreign(entry):
            return {"code": "foreign"}
        info = self.tracker.blob_info(self.regid, digest) if self.tracker else None
        if info:
            fail, ok = info.get("fail"), info.get("ok")
            if fail and (ok is None or fail[1] >= ok):
                return {"code": "failed", "status": fail[0], "t": fail[1], "ip": fail[2]}
        if self.downloading:
            return {"code": "in_progress"}
        if info and info.get("ok") is not None:
            return {"code": "evicted", "t": info["ok"]}
        return {"code": "not_requested"}


def analyse_image(store, ctx, manifest_digest, manifest, label):
    """One platform's worth of data: cached size and, for anything missing, why."""
    entries = image_entries(manifest)
    present, missing = [], []
    for kind, digest, entry in entries:
        if store.size(digest) is not None:
            present.append(digest)
        else:
            size = entry.get("size")
            missing.append({"digest": digest, "kind": kind,
                            "size": size if isinstance(size, int) else None,
                            "reason": ctx.reason(digest, entry)})
    info = {
        "platform": label, "cached": True, "complete": not missing, "missing": missing,
        "size": sum(store.size(d) for d in present) + (store.size(manifest_digest) or 0),
        "layers": sum(1 for kind, _, _ in entries if kind == "layer"),
    }
    return info, present


def analyse_tag(store, ctx, digest):
    """Describe what is cached for the manifest a tag points at."""
    info = {"digest": digest, "kind": "missing", "platforms": [], "layers": 0, "built": None}
    blobs = set()
    manifest = store.read_json(digest)
    if manifest is None:
        return info, blobs
    blobs.add(digest)

    def built_from(cfg_digest):
        cfg = store.read_json(cfg_digest) if cfg_digest else None
        created = cfg.get("created") if cfg else None
        return created if isinstance(created, str) else None

    if manifest.get("mediaType") in INDEX_TYPES or "manifests" in manifest:
        info["kind"] = "index"
        for child in manifest.get("manifests") or []:
            if not isinstance(child, dict):
                continue
            child_digest = child.get("digest")
            label = platform_label(child)
            attestation = (child.get("annotations") or {}).get("vnd.docker.reference.type") \
                == "attestation-manifest" or label == "unknown/unknown"
            child_manifest = store.read_json(child_digest) if child_digest else None
            if child_manifest is None:
                if not attestation and child_digest:
                    size = child.get("size")
                    info["platforms"].append({
                        "platform": label, "cached": False, "complete": False, "size": 0, "layers": 0,
                        "missing": [{"digest": child_digest, "kind": "manifest",
                                     "size": size if isinstance(size, int) else None,
                                     "reason": ctx.reason(child_digest)}]})
                continue
            plat, present = analyse_image(store, ctx, child_digest, child_manifest, label)
            blobs.add(child_digest)
            blobs.update(present)
            if not attestation:
                info["platforms"].append(plat)
                if info["built"] is None:
                    info["built"] = built_from((child_manifest.get("config") or {}).get("digest"))
    else:
        info["kind"] = "image"
        cfg = manifest.get("config") or {}
        cfg_json = store.read_json(cfg.get("digest")) if cfg.get("digest") else None
        label = "unknown"
        if cfg_json:
            label = "/".join(p for p in (cfg_json.get("os"), cfg_json.get("architecture"),
                                         cfg_json.get("variant")) if p) or "unknown"
        plat, present = analyse_image(store, ctx, digest, manifest, label)
        blobs.update(present)
        info["platforms"].append(plat)
        info["layers"] = plat["layers"]
        info["built"] = built_from(cfg.get("digest"))
    return info, blobs


def scan_registry(reg, tracker, names):
    root = os.path.join(DATA_DIR, reg["id"], "docker", "registry", "v2")
    store = Store(root)
    ctx = ScanContext(reg["id"], tracker)
    out = dict(reg)
    out.update({"repos": [], "repo_count": 0, "tag_count": 0,
                "disk_bytes": 0, "blob_count": 0, "initialised": os.path.isdir(root)})
    if not out["initialised"]:
        return out

    for name in store.repositories():
        ctx.downloading = store.uploads_active(name)
        repo_blobs, tags, newest = set(), [], 0.0
        for tag, digest, mtime in store.tags(name):
            info, blobs = analyse_tag(store, ctx, digest)
            repo_blobs |= blobs
            info.update({"name": tag, "updated": mtime,
                         "size": sum(store.size(b) or 0 for b in blobs)})
            if tracker:
                info["activity"] = tracker.activity(reg["id"], name, tag, digest, mtime, names)
            tags.append(info)
            newest = max(newest, mtime)
        if not tags:
            continue
        tags.sort(key=lambda t: t["updated"], reverse=True)
        out["repos"].append({"name": name, "tags": tags, "updated": newest,
                             "size": sum(store.size(b) or 0 for b in repo_blobs)})
    out["repo_count"] = len(out["repos"])
    out["tag_count"] = sum(len(r["tags"]) for r in out["repos"])
    out["disk_bytes"], out["blob_count"] = store.total_blob_bytes()
    return out


def scan_all():
    started = time.time()
    names = load_client_names()
    regs = [scan_registry(r, TRACKER, names) for r in parse_registries()]
    disk = None
    try:
        usage = shutil.disk_usage(DATA_DIR)
        disk = {"total": usage.total, "used": usage.used, "free": usage.free}
    except OSError:
        pass
    return {"registries": regs, "disk": disk, "scanned_at": time.time(),
            "scan_seconds": round(time.time() - started, 2)}


# --------------------------------------------------------------------------- deleting
_delete_lock = threading.Lock()


def _store_for(regid):
    if regid not in {r["id"] for r in parse_registries()}:
        raise NotFound(f"unknown registry {regid!r}")
    return Store(os.path.join(DATA_DIR, regid, "docker", "registry", "v2"))


def delete_image(store, repo, tags=None):
    """Remove tags (or, with tags=None, the whole repository) and free every blob nothing else uses."""
    rp = store.repo_path(repo)
    current = {n: d for n, d, _ in store.tags(repo)}
    if not os.path.isdir(rp):
        raise NotFound(f"repository {repo!r} is not in the cache")
    if tags is not None:
        absent = [t for t in tags if t not in current]
        if absent:
            raise NotFound(f"tag {absent[0]!r} is not in the cache")
    targets = list(current) if tags is None else list(tags)
    memo = {}
    cand_m, cand_b = set(), set()
    for t in targets:
        m, b = store.closure(current[t], memo)
        cand_m |= m
        cand_b |= b

    if tags is None:
        revisions = store.revision_digests(repo)
        for d in revisions:
            m, b = store.closure(d, memo)
            cand_m |= m
            cand_b |= b
        cand_m |= set(revisions)
        cand_b |= set(store.layer_digests(repo))
        for sub in ("_manifests", "_layers", "_uploads"):
            shutil.rmtree(os.path.join(rp, sub), ignore_errors=True)
    else:
        for t in targets:
            shutil.rmtree(os.path.join(rp, "_manifests", "tags", t), ignore_errors=True)
        keep_m, keep_b = set(), set()
        for name, d in current.items():
            if name not in targets:
                m, b = store.closure(d, memo)
                keep_m |= m
                keep_b |= b
        for d in cand_m - keep_m:
            shutil.rmtree(os.path.join(rp, "_manifests", "revisions", "sha256", d[7:]), ignore_errors=True)
        for d in cand_b - keep_b:
            shutil.rmtree(os.path.join(rp, "_layers", "sha256", d[7:]), ignore_errors=True)

    protected = store.protected_digests(memo)
    removed = freed = 0
    gone = set()
    for d in (cand_m | cand_b) - protected:
        existed, size = store.remove_blob(d)
        if existed:
            removed += 1
            freed += size
        gone.add(d)
    store.prune_repo(repo)
    return {"tags": len(targets), "blobs": removed, "freed_bytes": freed, "digests": gone,
            "tag_names": targets}


def wipe_registry(regid):
    store = _store_for(regid)
    repos = store.repositories()
    tags = sum(1 for r in repos for _ in store.tags(r))
    freed = store.total_blob_bytes()[0]
    for sub in ("repositories", "blobs"):
        shutil.rmtree(os.path.join(store.root, sub), ignore_errors=True)
    try:
        os.remove(os.path.join(DATA_DIR, regid, "scheduler-state.json"))
    except OSError:
        pass
    return {"images": len(repos), "tags": tags, "freed_bytes": freed}


def run_delete(req):
    """Validate a delete request and carry it out. Returns a result dict."""
    scope = req.get("scope")
    if scope not in ("tag", "repo", "registry", "all"):
        raise ValueError("scope must be one of: tag, repo, registry, all")
    with _delete_lock:
        if scope == "all":
            total = {"images": 0, "tags": 0, "freed_bytes": 0}
            for reg in parse_registries():
                r = wipe_registry(reg["id"])
                for k in total:
                    total[k] += r[k]
            if TRACKER:
                TRACKER.forget()
            return total
        regid = req.get("registry")
        if not isinstance(regid, str):
            raise ValueError("registry is required")
        if scope == "registry":
            result = wipe_registry(regid)
            if TRACKER:
                TRACKER.forget(regid)
            return result
        if scope in ("repo", "tag"):
            store = _store_for(regid)
            repo, tag = req.get("repo"), req.get("tag")
            if not isinstance(repo, str):
                raise ValueError("repo is required")
            if scope == "tag":
                if not isinstance(tag, str) or not TAG_RE.match(tag):
                    raise ValueError("a valid tag is required")
            res = delete_image(store, repo, [tag] if scope == "tag" else None)
            if TRACKER:
                TRACKER.forget(regid, repo, None if scope == "repo" else res["tag_names"],
                               res["digests"], res["digests"])
            return {"images": 1 if scope == "repo" else 0, "tags": res["tags"],
                    "blobs": res["blobs"], "freed_bytes": res["freed_bytes"]}


# --------------------------------------------------------------------------- scan state
_lock = threading.Lock()
_state = {"data": None, "at": 0.0, "thread": None, "error": None}


def _run_scan():
    try:
        data = scan_all()
        with _lock:
            _state.update(data=data, at=time.time(), error=None)
    except Exception as exc:  # keep serving the previous scan
        with _lock:
            _state["error"] = f"{type(exc).__name__}: {exc}"


def start_scan(force=False):
    """Start a background scan if the last one is stale; returns the running thread, if any."""
    with _lock:
        thread = _state["thread"]
        if thread and thread.is_alive():
            return thread
        if not force and _state["data"] is not None and time.time() - _state["at"] < SCAN_TTL:
            return None
        thread = threading.Thread(target=_run_scan, daemon=True)
        _state["thread"] = thread
        thread.start()
        return thread


def rescan_now():
    """A scan that is certain to start after the caller's changes."""
    running = start_scan()
    if running:
        running.join(timeout=300)
    thread = start_scan(force=True)
    if thread:
        thread.join(timeout=300)


def snapshot(wait_for=None):
    if wait_for is not None:
        wait_for.join(timeout=300)
    with _lock:
        thread = _state["thread"]
        data = dict(_state["data"]) if _state["data"] else None
        error = _state["error"]
        scanning = bool(thread and thread.is_alive())
    base = data if data is not None else {"registries": [], "disk": None, "scanned_at": None}
    base.update(
        scanning=scanning, error=error, ttl=CACHE_TTL, clients=load_client_names(),
        ca_available=os.path.isfile(os.path.join(PUBLIC_CERT_DIR, "ca.crt")),
        capabilities={"delete": ALLOW_DELETE, "token": bool(ADMIN_TOKEN)},
        tracking={"enabled": bool(TRACKER and TRACKER.enabled), "since": TRACKER.since if TRACKER else None},
    )
    return base


# --------------------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    server_version = "registry-cache-ui"

    def log_message(self, fmt, *args):  # keep container logs quiet
        pass

    def _send(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store" if ctype.startswith("application/json") else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, status=200):
        self._send(status, json.dumps(payload).encode(), "application/json; charset=utf-8")

    def _file(self, path, ctype=None, extra=None):
        try:
            with open(path, "rb") as fh:
                body = fh.read()
        except OSError:
            return self._json({"error": "not found"}, 404)
        ctype = ctype or mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self._send(200, body, ctype, extra)

    def do_GET(self):
        route = urlparse(self.path).path
        if route == "/healthz":
            return self._send(200, b"ok", "text/plain")
        if route == "/api/cache":
            thread = start_scan()
            # Block only for the very first scan; afterwards serve the last result at once
            # while a stale cache is rescanned in the background.
            return self._json(snapshot(thread if _state["data"] is None else None))
        if route == "/ca.crt":
            return self._file(os.path.join(PUBLIC_CERT_DIR, "ca.crt"), "application/x-x509-ca-cert",
                              {"Content-Disposition": 'attachment; filename="registry-cache-ca.crt"'})
        rel = route.lstrip("/") or "index.html"
        path = os.path.realpath(os.path.join(STATIC_DIR, rel))
        if path.startswith(STATIC_DIR + os.sep) and os.path.isfile(path):
            return self._file(path)
        self._json({"error": "not found"}, 404)

    def _authorise_change(self):
        """Gate for anything that modifies the cache. Returns an error response or None."""
        if not ALLOW_DELETE:
            return (403, "Deleting is switched off on this server (UI_ALLOW_DELETE=false).")
        # A custom header cannot be sent cross-site without a CORS preflight, which this server never grants.
        if self.headers.get("X-Registry-Cache") != "1":
            return (403, "Missing X-Registry-Cache header.")
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            return (403, "Cross-origin request refused.")
        if ADMIN_TOKEN:
            auth = self.headers.get("Authorization", "")
            supplied = auth[7:] if auth.startswith("Bearer ") else ""
            if not hmac.compare_digest(supplied.encode(), ADMIN_TOKEN.encode()):
                return (401, "The admin token is missing or wrong.")
        return None

    def do_POST(self):
        route = urlparse(self.path).path
        if route == "/api/refresh":
            return self._json(snapshot(start_scan(force=True)))
        if route != "/api/delete":
            return self._json({"error": "not found"}, 404)
        refused = self._authorise_change()
        if refused:
            return self._json({"error": refused[1]}, refused[0])
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length <= 4096:
                raise ValueError("request body missing or too large")
            req = json.loads(self.rfile.read(length))
            if not isinstance(req, dict):
                raise ValueError("request body must be a JSON object")
            result = run_delete(req)
        except NotFound as exc:
            return self._json({"error": str(exc)}, 404)
        except (ValueError, TypeError) as exc:
            return self._json({"error": str(exc)}, 400)
        except OSError as exc:
            return self._json({"error": f"Could not delete: {exc.strerror or exc}. "
                                        "Check that the cache folder is writable by the container."}, 500)
        rescan_now()
        self._json({"ok": True, "result": result, "snapshot": snapshot()})


def tracker_loop():
    while True:
        try:
            TRACKER.poll()
            TRACKER.save()
        except Exception as exc:  # never let tracking take the UI down
            print(f"tracker: {type(exc).__name__}: {exc}", flush=True)
        time.sleep(3)


def main():
    global TRACKER
    host_to_id = {r["upstream"]: r["id"] for r in parse_registries() if r["upstream"]}
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
    except OSError:
        pass
    TRACKER = Tracker(STATE_DIR, ACCESS_LOG, host_to_id)
    try:
        TRACKER.poll()          # catch up on the log first, so the first scan knows why things are missing
    except Exception as exc:
        print(f"tracker: {type(exc).__name__}: {exc}", flush=True)
    threading.Thread(target=tracker_loop, daemon=True).start()
    start_scan(force=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"registry-cache UI listening on :{PORT}, data={DATA_DIR}, "
          f"delete={'on' if ALLOW_DELETE else 'off'}{' (token required)' if ADMIN_TOKEN else ''}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

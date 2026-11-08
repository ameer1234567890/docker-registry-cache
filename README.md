# docker-registry-cache

A self-hosted, transparent pull-through cache for container registries, in **one container on port 443**. Clients keep using the real image names; the cache is chosen by the registry's hostname.

```
docker pull ghcr.io/owner/app   ──▶  ghcr.io                ─┐
docker pull quay.io/org/app     ──▶  quay.io                 ├──▶  this container :443  ──▶  cache  ──▶  real registry
docker pull alpine              ──▶  registry-1.docker.io   ─┘      (chosen by TLS server name)
```

A web UI (plain HTTP on `:8080`, and over TLS on any other name or IP) shows cached registries, images and sizes, with light and dark modes.

## What you need

1. **DNS on the clients** that sends each registry name (`ghcr.io`, `quay.io`, …) to this server. See [Client setup](#client-setup-system-wide).
2. **A certificate valid for those names**, trusted by the clients. You can bring your own (below) or let the container generate one.
3. **Port 443 free** on the host (or a dedicated IP via `BIND_ADDR`). Registry URLs carry no port, so it must be 443.

## Quick start

```bash
cp .env.example .env
mkdir -p certs && cp /path/to/server.crt /path/to/server.key certs/   # your certificate, see below
docker compose up -d        # pulls ameer1234567890/docker-registry-cache from Docker Hub
```

Open `http://<host>:8080`. The **Connect a client** button gives commands for your actual hostnames. Then follow [Client setup](#client-setup-system-wide).

## The image

`docker-compose.yml` runs the image named by `REGISTRY_IMAGE` (default `ameer1234567890/docker-registry-cache:latest`). Pin a version tag such as `:1.0.0` in `.env` if you want upgrades to be deliberate, then `docker compose pull && docker compose up -d` to move to a new one. Your certificate, credentials, registry list and cached data are all supplied at run time, so nothing private is inside the image.

### Building it from source

```bash
docker build -t ameer1234567890/docker-registry-cache:latest .
docker compose up -d
```

Docker Compose only pulls an image when it is not already on the machine, so after a local build under the same name it runs your build. Run `docker compose pull` to go back to the published one. The cache binary is taken from `registry:3` by default. To use another release, such as the older 2.x line, add `--build-arg REGISTRY_BASE_IMAGE=registry:2` to the build.

### Publishing it

```bash
docker login
docker build -t ameer1234567890/docker-registry-cache:latest -t ameer1234567890/docker-registry-cache:1.0.0 .
docker push --all-tags ameer1234567890/docker-registry-cache
```

For both Intel/AMD and ARM machines, build multi-architecture and push in one step:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ameer1234567890/docker-registry-cache:latest -t ameer1234567890/docker-registry-cache:1.0.0 --push .
```

`.dockerignore` keeps `.env`, `credentials.env`, `certs/` and `data/` out of the build, so they cannot end up in a published layer.

## Your certificate

Put these in `./certs` (or point `CERTS_DIR` elsewhere):

| File         | What                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------- |
| `server.crt` | Your certificate **with the chain** (leaf first, then intermediates and the root)            |
| `server.key` | Its private key, unencrypted PEM                                                             |
| `ca.crt`     | Optional. Your root certificate, so the UI can offer it for download to new clients          |

If both `server.crt` and `server.key` exist, they are used exactly as they are. Nothing is generated or modified, and you can mount the folder read-only (`:ro` on the `/certs` volume in `docker-compose.yml`). Different file names? Mount them individually:

```yaml
    volumes:
      - /etc/ssl/mine/fullchain.pem:/certs/server.crt:ro
      - /etc/ssl/mine/privkey.pem:/certs/server.key:ro
```

**The certificate must list every registry hostname** as a subject alternative name, because clients connect to `ghcr.io`, not to your server's name. For the default registry list:

```
registry-1.docker.io  ghcr.io  quay.io  gcr.io  registry.k8s.io  mcr.microsoft.com
```

A wildcard such as `*.microsoft.com` also covers `mcr.microsoft.com`. At start-up the container checks each name against your certificate and logs a warning for any it does not cover. You can check beforehand:

```bash
for h in registry-1.docker.io ghcr.io quay.io gcr.io registry.k8s.io mcr.microsoft.com; do
  printf '%-22s' $h; openssl x509 -in certs/server.crt -noout -checkhost $h
done
```

### No certificate yet?

Leave `certs/` empty (and writable) and the container creates a root CA (`ca.crt`, `ca.key`) and a server certificate covering every registry in your list. If you only have a root (`ca.crt` + `ca.key`), put those in and it signs the server certificate with your root. A generated certificate is reissued when the registry list or `TLS_SANS` changes, 30 days before it expires, or when `TLS_REGENERATE=true`. A `ca.crt` without `ca.key` (and no server certificate) stops the container with an explanation instead of overwriting anything.

The web UI runs as an unprivileged user and can only read a public copy of `ca.crt`, never a key.

## Choosing the registries

The list lives in `docker-compose.yml`, in the `CACHE_REGISTRIES` setting, one line per registry (`id | display name | upstream URL`). There is no separate file to maintain: if you leave the setting out, the image falls back to the same six built-in registries (Docker Hub, GHCR, Quay, GCR, registry.k8s.io, MCR).

```yaml
      CACHE_REGISTRIES: |
        hub|Docker Hub|https://registry-1.docker.io
        ghcr|GitHub Container Registry|https://ghcr.io
        # quay|Quay|https://quay.io        <- a leading # switches a line off
        internal|Our registry|https://registry.corp.example
        us-gcr|Google, US|https://us.gcr.io
```

The **hostname** in the URL is what clients type and what nginx routes on, so it must have no port and no path. The id is just a label and the data folder (`./data/<id>`). The container refuses to start, with a message naming the line, if a hostname has a port, an id is invalid, or a hostname appears twice. After editing, run `docker compose up -d`, add the new name to your client DNS, and make sure your certificate covers it.

## Client setup (system-wide)

Do this on every machine whose pulls should go through the cache: developer laptops, CI runners, Kubernetes nodes. The web UI's **Connect a client** button prints the commands for your registries.

### Quick setup with the script (Linux and macOS)

The cache serves a setup script that does steps 1 to 3 below for you. Open **Connect a client** in the web UI and copy the command shown there. It looks like this:

```bash
curl -fsSL http://CACHE-HOST:8080/setup.sh | sudo sh -s -- --fingerprint 'AA:BB:CC:...'
```

The script is generated by the cache for each request, so the address and the list of registries are always current. It:

1. downloads the root certificate and **refuses it unless its SHA-256 fingerprint matches** the one you pass,
2. adds one marked block to `/etc/hosts` pointing every registry name at the cache (the original is backed up once),
3. trusts the certificate: system-wide, and for each registry under Docker's and Podman's `certs.d`, so Docker works without a restart,
4. checks every name, reporting whether it resolves to the cache and whether TLS validates.

**Why the fingerprint matters.** This script installs a root certificate, and a plain-HTTP download can be tampered with by anyone on the network. The fingerprint in the command comes from the UI you opened, so a swapped certificate is refused and nothing is changed. Without `--fingerprint` the script asks you to confirm the fingerprint at the terminal, and stops if there is none. `--yes` skips the check, so use it only on a network you trust.

| Option                  | Effect                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `--dry-run`             | Show what would change and change nothing (needs no root)                                    |
| `--check`               | Only test the current setup: do the names resolve to the cache, is TLS trusted                |
| `--remove`              | Undo everything the script did: the hosts block and every certificate file it created         |
| `--no-system-trust`     | Trust the certificate for Docker and Podman only, not for the whole machine                  |
| `--no-hosts`            | Leave `/etc/hosts` alone, because your DNS already points the names at the cache             |
| `--no-trust`            | Only set up the names; use when the server certificate is issued by something already trusted |
| `--ca FILE`             | Use your own root certificate file instead of downloading one                                 |
| `--ip ADDRESS`          | Address of the cache, if the UI was reached under a name that does not resolve for the client |
| `--url URL`, `--hosts "a.io b.io"` | Override where it downloads from, or which names it sets up                       |

It is safe to run again: it replaces its own block, never duplicates it, and leaves every other line of `/etc/hosts` as it was. If a registry name is also set elsewhere in `/etc/hosts`, it warns you.

Needs root, plus `curl` or `wget`. It reads your system to choose the right trust store: Debian, Ubuntu and Alpine (`update-ca-certificates`), Red Hat, Fedora and Arch (`update-ca-trust`), SUSE, and macOS (`security`). Afterwards, restart containerd on Kubernetes nodes so it re-reads the system store.

**What it does not cover.** There is no Windows version; follow the manual steps below. The Linux behaviour is covered by automated tests, run against a sandboxed filesystem with the trust tools stubbed out. The macOS path uses Apple's documented `security` commands but has not been run on a Mac. If it misbehaves, use the manual steps.

You can also run it from a clone of this repository, which has no way to know your cache's address:

```bash
sudo sh client/setup.sh --url http://CACHE-HOST:8080 --ip CACHE-IP --hosts "registry-1.docker.io ghcr.io" --fingerprint 'AA:BB:...'
```

The manual steps follow, for other systems or if you prefer to see each one.

### 1. Send the registry names to the cache

Use the cache server's IP in place of `192.168.1.50`.

**Best for a whole network: a DNS server.** One set of records serves every client.

```ini
# dnsmasq / Pi-hole (a file in /etc/dnsmasq.d/)
address=/registry-1.docker.io/192.168.1.50
address=/ghcr.io/192.168.1.50
address=/quay.io/192.168.1.50
address=/gcr.io/192.168.1.50
address=/registry.k8s.io/192.168.1.50
address=/mcr.microsoft.com/192.168.1.50
```

```yaml
# unbound
server:
  local-data: "ghcr.io. A 192.168.1.50"
  local-data: "quay.io. A 192.168.1.50"
  # …one line per name
```

Then point the clients at that DNS server (DHCP option, router, or `resolvectl dns eth0 192.168.1.2`). Note that dnsmasq's `address=/ghcr.io/…` also covers subdomains of that name.

**Best for a few machines: the hosts file.** Add one line:

```
192.168.1.50  registry-1.docker.io ghcr.io quay.io gcr.io registry.k8s.io mcr.microsoft.com
```

- Linux and macOS: `/etc/hosts` (as root)
- Windows: `C:\Windows\System32\drivers\etc\hosts` (as Administrator)

### 2. Trust your root certificate system-wide

Download `ca.crt` from the UI (`http://<host>:8080/ca.crt`), or use your own root.

| System                  | Command                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Debian, Ubuntu, Alpine  | `sudo cp ca.crt /usr/local/share/ca-certificates/registry-cache.crt && sudo update-ca-certificates`                                  |
| RHEL, Fedora, Rocky     | `sudo cp ca.crt /etc/pki/ca-trust/source/anchors/registry-cache.crt && sudo update-ca-trust`                                         |
| Arch                    | `sudo trust anchor --store ca.crt`                                                                                                   |
| macOS                   | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.crt`                                         |
| Windows (admin PowerShell) | `Import-Certificate -FilePath .\ca.crt -CertStoreLocation Cert:\LocalMachine\Root`                                                |

If your certificate was issued by a root that machines already trust (for example your company's), skip this step.

### 3. Restart the container runtime

Runtimes read the trust store and DNS when they start:

```bash
sudo systemctl restart docker          # Docker
sudo systemctl restart containerd      # containerd, and Kubernetes nodes using it
```

Podman, Buildah and Skopeo pick the changes up immediately. On Docker Desktop (macOS, Windows) trust the root in the operating system as above and restart Docker Desktop; it normally resolves names through the host, so a hosts-file entry works there too.

**Without touching the system trust store**, Docker and Podman can trust the root per registry instead:

```bash
for h in registry-1.docker.io ghcr.io quay.io gcr.io registry.k8s.io mcr.microsoft.com; do
  sudo install -D -m 644 ca.crt /etc/docker/certs.d/$h/ca.crt          # Docker
  # sudo install -D -m 644 ca.crt /etc/containers/certs.d/$h/ca.crt    # Podman
done
```

### 4. Check it

```bash
getent hosts ghcr.io                                   # should print the cache server's IP
curl -sI https://ghcr.io/v2/ | grep -i distribution    # docker-distribution-api-version: registry/2.0
docker pull ghcr.io/<owner>/<image>:<tag>              # then look for it in the web UI
```

Kubernetes needs no `hosts.toml` or mirror settings: with DNS and trust set up on the nodes, containerd's normal pulls of `registry.k8s.io/...` and `ghcr.io/...` reach the cache.

### Clients that use an HTTP(S) proxy

This cache is a registry, not a forward proxy, so you do **not** set `HTTP_PROXY` or `HTTPS_PROXY` to point clients at it. The DNS entries above do that job.

But if the clients' container runtime is already configured to go through a corporate proxy, it would send registry traffic to that proxy, which resolves the real address and bypasses the cache. Add the registry names to `NO_PROXY` so the runtime connects to the cache directly:

```ini
# /etc/systemd/system/docker.service.d/proxy.conf   (same idea for containerd.service.d)
[Service]
Environment="HTTPS_PROXY=http://proxy.corp.example:3128"
Environment="NO_PROXY=localhost,127.0.0.1,registry-1.docker.io,ghcr.io,quay.io,gcr.io,registry.k8s.io,mcr.microsoft.com"
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart docker
```

For all other tools on a machine, the same variables go in `/etc/environment` (`HTTPS_PROXY=…`, `NO_PROXY=…`, plus the lower-case `https_proxy` and `no_proxy` for tools that only read those).

### If the cache itself must use a proxy

The cache's own traffic to the real registries can go through one. Set in `.env`:

```
HTTPS_PROXY=http://proxy.corp.example:3128
NO_PROXY=localhost,127.0.0.1
```

If that proxy inspects TLS, put its root certificate (PEM) in `certs/upstream/` so the cache trusts it.

### Undo

Remove the DNS records or hosts line, and the certificate from the trust store (delete the file you copied, then run `sudo update-ca-certificates --fresh` or `sudo update-ca-trust`). Pulls go straight to the real registries again.

## The web UI

- Total cache size, free space on the volume, and a scale drawing of the largest images.
- A list of registries with size and share of the cache, and a searchable, sortable table of images. Expand an image for its tags, platforms, sizes, build date, digest, and the `docker pull` command to copy.
- **How well it works:** bandwidth saved, hit rate and a daily chart, for the whole cache or one registry ([details below](#cache-performance)).
- **Who pulled it:** for every tag, which host requested it first and which hosts pulled it afterwards ([details below](#who-pulled-what)).
- **Why something is missing:** when a platform or layer is not cached, the reason is shown next to it ([details below](#why-some-layers-are-not-cached)).
- **Deleting:** remove one tag, a whole image, everything from one registry, or the entire cache, each behind a warning dialog ([details below](#deleting-from-the-cache)).
- **Light and dark mode.** The toggle is saved in the browser (`localStorage`); with no saved choice the UI follows your operating system.

Sizes are read straight from the registries' storage, because the tag API of a pull-through registry asks the upstream and cannot say what is cached locally. They are compressed bytes on disk. A multi-arch tag counts only platforms that have actually been pulled. The large headline number is real disk usage, so layers shared between images count once there; per-image sizes can add up to more.

The table lists tagged images. Content that was only ever pulled by digest (`image@sha256:...`, common in Kubernetes manifests) is cached and counts toward the totals, but has no tag to show. The registry and whole-cache delete operations do remove it.

### Who pulled what

Expand an image and look at **First pulled by**. It names the host whose request caused the image to be fetched and cached, and how many later pulls were served from the cache. Select it for the full history: each later host with its number of pulls, when it last pulled, and its client software (`docker/27.3.1`, `containerd/1.7.2`, ...).

How it works: nginx writes one JSON line per registry request to `data/.registry-cache/access.log`, and the UI reads it continuously and keeps its own history next to it (`tracking.json`). The raw log is emptied once it has been read and grows past 20 MB. The history survives restarts and is forgotten for an image when you delete it.

- **Hosts are client addresses**, exactly as nginx sees them. Name them in `clients.conf` (`ip|name`, one per line). It is picked up on the next scan. If a change does not show up, recreate the container (`docker compose up -d --force-recreate`): some editors replace the file, which a single-file mount does not follow.
- **Behind NAT.** Docker Desktop, another reverse proxy or a load balancer in front of the cache replaces the real client address with its own. Then every pull looks like it came from that device.
- **A pull counts once**, even though a client sends several requests for it (a check for the tag, then a request for its digest).
- **Re-cached images start over.** If an image expires and is fetched again, or its tag moves to new content, only requests since then belong to the new copy.
- **Images cached before tracking started** show "Not recorded" as the first puller. Their later pulls are listed from the moment tracking began.

### Cache performance

The **Cache performance** panel shows what the cache is worth, for the last 7 days, the last 30 days, or all time. Select a registry in the list to see only its numbers.

- **Bandwidth saved** is the data served from the cache that clients would otherwise have downloaded from the upstream registry again.
- **Hit rate** is shown by data and by number of layers. **Served from the cache** and **Fetched from upstream** are the two halves of the data. The daily chart stacks them.
- **Failed requests** counts layer downloads that failed, such as upstream rate limits. The image's own details say which layer and why.

What counts: layer downloads (layers and image configs). Manifests are a few kilobytes and are checked against upstream on every tag pull anyway, so they are left out.

**How a hit is recognised.** The registry does not say whether it served a layer from disk or fetched it, so the UI works it out. nginx logs how long each request took, which gives the moment it began. A layer whose file on disk is older than that existed beforehand, so it was a **hit**. A file written while the request ran was fetched from upstream by it, so it was a **miss**. When the file cannot settle it (a replayed log, a layer since evicted), the UI falls back to whether that layer had been served successfully before. Treat the result as a close estimate: it deliberately leans towards counting misses, so savings are understated rather than flattered.

- Two clients that start downloading an uncached layer at the same moment both count as misses, because both really did fetch it from upstream.
- A layer that expired and was fetched again counts as a miss.
- Layers cached before tracking started count as hits from their first request after it did.
- Days are UTC. Per-day numbers are kept for 90 days and lifetime totals are kept indefinitely, in `data/.registry-cache/tracking.json`. They survive restarts and deleting images, because they describe traffic rather than what is stored. To start from zero, stop the container and delete that file (which also clears the pull history).
- The panel appears only when the request log exists, so it is hidden if the UI runs outside the container.

### Why some layers are not cached

A pull-through cache stores only what clients request, so a manifest can list more than is on disk. The image still pulls normally; missing parts are fetched from the upstream registry when someone asks. When a platform or layer is missing, the table says why and **Details** lists each missing item:

| Reason shown                      | What it means                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Never requested                   | No client has asked for the layer through the cache. Clients skip layers they already have locally, or the pull stopped before reaching it. |
| Upstream fetch failed             | A request for it failed. The status is shown with the host and time, e.g. HTTP 429 (rate limit), 401/403 (add credentials), 404, 5xx, or 499 (the client cancelled mid-download). |
| Expired or removed                | It was cached earlier and is gone now: it passed `CACHE_TTL`, or was deleted from disk.                                                     |
| Cannot be cached                  | A non-distributable ("foreign") layer, such as some Windows base layers. Clients fetch it from its own source.                              |
| Downloading now                   | A download into that repository is in progress.                                                                                             |

Architectures that no client has pulled are not listed at all: for a multi-arch image that is the normal state, not a problem. A platform appears only if it is missing for a real reason, such as a failed fetch or expiry.

The failure and expiry reasons come from the request history above, so they apply from the time tracking started.

### Deleting from the cache

Four operations, each with its own confirmation dialog that explains what will be removed, how much space is freed, and that it cannot be undone:

| Operation                    | Where                                                        | Extra safeguard                       |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| Delete one tag               | Trash icon on a tag row                                      |                                       |
| Delete an image (all tags)   | Trash icon on the image row                                  |                                       |
| Delete everything in a registry | Select the registry, then **Delete all in ...**           | Tick "I understand" to enable Delete  |
| Delete the entire cache      | Select **All registries**, then **Delete entire cache**      | Tick "I understand" to enable Delete  |

Cancel is focused by default, so pressing Enter in the dialog never deletes.

Layers shared with other cached images are kept. Deleting `alpine:3.20` frees its own layers but not a layer that `nginx:1.27` also uses; that one is freed when the last image using it goes. A registry's data folder and your settings are never deleted.

A registry in proxy mode refuses delete requests over its API, so the UI removes the files itself and then frees every blob nothing else references. Cached copies are simply re-fetched from upstream the next time a client pulls, which **counts against upstream rate limits**. Pulls that are running at the moment of a delete may fail and need a retry.

**Controls.** Anyone who can reach the UI can delete, so:

- `UI_ADMIN_TOKEN=...` makes the UI ask for that token in the confirmation dialog.
- `UI_ALLOW_DELETE=false` removes every delete button and makes the server refuse delete requests.
- Delete requests need a custom header that a web page on another site cannot send, and requests from another origin are refused, so a malicious page cannot trigger a delete from a browser on your network.
- Put the UI behind your own authenticating reverse proxy, or bind it to a trusted interface with `BIND_ADDR`, for anything more.

**Permissions.** The registries and the UI run as an unprivileged `cache` user. On first start the container gives that user ownership of `./data` (once, recursively, so upgrading from an older version with root-owned data may take a moment on a large cache). On the host that folder then shows as owned by uid 10001. The root-only certificate key stays unreadable to them.

### Limiting the cache size

Without a limit the cache only shrinks through `CACHE_TTL`, so a busy cache can fill the disk. Set an upper size in `.env`:

```
CACHE_MAX_SIZE=50GB
```

It accepts `500MB`, `50GB`, `1.5TB` (powers of 1000, like the sizes in the UI) or `20GiB` (powers of 1024). Empty or `0` means no limit, which is the default. A value that is not a size stops the container with a message instead of being ignored. The UI then shows how much of the limit is used.

How it works:

- **Once a minute** the cache's size is checked. If it is over the limit, images are removed **least recently pulled first**, until the cache is down to **90% of the limit**. The margin stops it from removing a little every minute once the cache is full.
- **"Pulled"** means a client asked for the image, including the quick up-to-date check that `docker pull` makes when it already has the image. An image cached ten days ago and pulled two hours ago outranks one cached five days ago and never pulled since. Images with no recorded pull are ranked by when they were cached.
- **Tags on the same image count together** (`latest` and `3.20` pointing at one image): the image is in use if any of its tags is, and it goes as one.
- **Digest-only images** (`image@sha256:...`), which have no tag in the list, are removed the same way, so a pinned Kubernetes image cannot silently break the limit.
- **Shared layers** are kept while another cached image uses them, so removing an image frees only what is exclusively its own, and the clean-up keeps going until the size is really down.
- **Nothing pulled in the last five minutes is ever removed.** If that leaves the cache over the limit, it stays over until those images age, and the UI says so.
- Every removal is written to the container log (`[cache limit] removed library/nginx:1.27 ...`), and the footer of the UI shows the last clean-up.

Good to know: the size is checked every minute, so a very large pull can briefly take the cache past the limit. The size counts layer data in the cache folder, not free space on the disk, so leave headroom on the volume. `CACHE_MAX_SIZE` works independently of `UI_ALLOW_DELETE`: that setting only controls the buttons, while the limit is a server-side policy. Anything evicted is fetched from upstream again on its next pull, which counts against upstream rate limits.

## Configuration

Set in `.env` (see `.env.example`).

| Variable                       | Default            | Purpose                                                                  |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------ |
| `REGISTRY_IMAGE`               | `ameer1234567890/docker-registry-cache:latest` | The image to run                                   |
| `BIND_ADDR`                    | `0.0.0.0`          | Interface the cache listens on (port 443)                                |
| `UI_PORT`                      | `8080`             | Plain-HTTP web UI                                                        |
| `UPSTREAM_DNS`, `UPSTREAM_DNS_2` | `1.1.1.1`, `8.8.8.8` | Resolvers the cache uses to reach the real registries (see warning below) |
| `HTTPS_PROXY`, `NO_PROXY`      | _(empty)_          | Outbound proxy for the cache's own upstream traffic                      |
| `CERTS_DIR`                    | `./certs`          | Your `server.crt`, `server.key`, optional `ca.crt`                       |
| `UPSTREAM_CA_DIR`              | `./certs/upstream` | Extra roots to trust when talking to upstream registries                 |
| `CACHE_DATA_DIR`               | `./data`           | Cached blobs, one sub-folder per registry                                |
| `CACHE_TTL`                    | `720h`             | Evict items this long after they were fetched (`0` = never)              |
| `CACHE_MAX_SIZE`               | _(empty)_          | Upper size limit, e.g. `50GB`; least recently pulled images go first     |
| `LOG_LEVEL`                    | `error`            | Log level of the registries (see below)                                  |
| `UI_ALLOW_DELETE`              | `true`             | `false` switches deleting from the UI off completely                     |
| `UI_ADMIN_TOKEN`               | _(empty)_          | If set, required to delete from the UI                                   |
| `TLS_SANS`                     | _(empty)_          | Extra names/IPs, only for a generated certificate                        |
| `HUB_USERNAME`, `HUB_PASSWORD` | _(empty)_          | Docker Hub login, to avoid the anonymous pull limit                      |

**Warning: `UPSTREAM_DNS` must return the real addresses.** If the cache resolved `ghcr.io` through your override DNS it would send requests to itself. The container probes for this shortly after start and logs a warning. If your network has no access to public DNS, set these to a resolver that has no overrides for the registry names.

### Docker Hub login

Docker Hub limits anonymous pulls per IP address, and every client of the cache shares the cache's address, so an unauthenticated cache can hit the limit quickly. Log it in by setting these in `.env` (or directly in the `environment:` block of `docker-compose.yml`):

```
HUB_USERNAME=your-dockerhub-username
HUB_PASSWORD=dckr_pat_xxxxxxxxxxxxxxxx
```

- **Use an access token as the password**, not your account password: Docker Hub, Account settings, Personal access tokens. Read-only access is enough, and a token can be revoked without changing your password.
- Restart to apply: `docker compose up -d`. The start-up log says `(authenticated)` next to the Docker Hub line, or `Docker Hub is anonymous` if no login is set.
- Both values are required. If only one is set, the container refuses to start and says which is missing.
- Keep `.env` private (`chmod 600 .env`). It is already in `.gitignore`.
- **Cached content is served to everyone.** The cache uses this login for every client, so anyone who can reach it can pull whatever that account can read, including its private repositories. A login also lifts the limit rather than removing it: pulls that miss the cache still count, which is where a cache helps most.
- If the limit is hit anyway, the image's missing layers show the reason ("rate-limited the request (HTTP 429)").

### Other registries

Other registries use an optional `credentials.env` (copy `credentials.env.example`). Add a pair per registry, named after its id in upper case (`-` becomes `_`):

```
GHCR_USERNAME=your-github-username
GHCR_PASSWORD=ghp_xxxxxxxxxxxxxxxx
```

The same rule applies: anyone who can reach the cache can read what these credentials can read.

### Registry log messages

The registries log at `error` by default. Registry 2.8.3 printed two messages at every start, once per registry, that are expected in cache mode and do not mean anything is wrong:

- `Registry does not implement RepositoryRemover. Will not be able to delete repos and tags`: the registry reports that a pull-through cache does not support deleting repositories and tags through its HTTP API. Nothing here uses that API. The web UI removes cached files itself, and expiry (`CACHE_TTL`) is handled inside the cache.
- `No HTTP secret provided - generated random secret`: only matters for resumable uploads, which a cache never receives. The container now supplies a secret, so this one no longer appears.

The image is now built on registry 3, which may print different start-up messages. Set `LOG_LEVEL=warn` (or `info`) in `.env` to see what yours prints, or to investigate a problem. Real failures, such as an upstream that is unreachable or rejects the login, are logged at `error` and always show.

## Maintenance

- **Clear a registry or the whole cache:** use the delete buttons in the UI. From the command line: `docker compose stop && rm -rf data/ghcr/docker && docker compose start`.
- **Reclaim space from removed manifests:** `docker compose exec docker-registry-cache registry garbage-collect /run/registry/hub.yml`
- **Logs:** `docker compose logs -f docker-registry-cache`

## Limitations

- **A name pointed at the cache is only a registry for those clients.** Anything else at that name (for example the quay.io website in a browser) will not work from a client that resolves it to the cache. Registry API traffic (`/v2/…`) is unaffected.
- Registry names that are not in `CACHE_REGISTRIES` (for example `us.gcr.io`, `docker.elastic.co`) are not cached. Add a line for each one you use. Wildcard hosts need one entry per hostname.
- Pull-through only; pushing is not possible by design.
- One container means one failure domain: if any internal process exits, the container stops and Docker restarts all of them.
- The registry expires cached items `CACHE_TTL` after they were fetched (not after they were last used); a later pull fetches them again. Raise it, or set `0`, for a long-lived cache and watch the disk meter in the UI.
- The UI has no login of its own, and it can delete. Set `UI_ADMIN_TOKEN`, put it behind your own reverse proxy, or restrict `BIND_ADDR` on untrusted networks. Set `UI_ALLOW_DELETE=false` to make it read-only.
- Pull history needs the client's real address. See the NAT note under [Who pulled what](#who-pulled-what).

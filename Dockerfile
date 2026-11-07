# One image, one container: registry:2 (pull-through, one process per upstream),
# nginx (TLS on a single port, routes by hostname) and the web UI.
ARG REGISTRY_BASE_IMAGE=registry:2
FROM ${REGISTRY_BASE_IMAGE} AS registry

# The -slim variant is the same nginx build without the optional modules (image filter, XSLT, GeoIP, njs)
# and their libraries. Nothing here uses them, and leaving them out saves roughly 35-40 MB.
FROM nginx:1.27-alpine-slim
RUN apk add --no-cache openssl python3 su-exec ca-certificates \
 && rm -f /etc/nginx/conf.d/default.conf \
 && addgroup -g 10001 cache && adduser -D -H -u 10001 -G cache cache

COPY --from=registry /bin/registry /usr/local/bin/registry
COPY container/entrypoint.sh container/tls.sh /usr/local/bin/
COPY container/proxy-common.conf /etc/nginx/proxy-common.conf
COPY clients.conf /etc/registry-cache/clients.conf
COPY ui/ /app/
COPY client/setup.sh /app/client-setup.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/tls.sh

EXPOSE 443 8080
VOLUME ["/data", "/certs"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

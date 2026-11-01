# One image, one container: registry:2 (pull-through, one process per upstream),
# nginx (TLS on a single port, routes by hostname) and the web UI.
ARG REGISTRY_IMAGE=registry:2
FROM ${REGISTRY_IMAGE} AS registry

FROM nginx:1.27-alpine
RUN apk add --no-cache openssl python3 su-exec ca-certificates \
 && rm -f /etc/nginx/conf.d/default.conf \
 && addgroup -g 10001 cache && adduser -D -H -u 10001 -G cache cache

COPY --from=registry /bin/registry /usr/local/bin/registry
COPY container/entrypoint.sh container/tls.sh /usr/local/bin/
COPY container/proxy-common.conf /etc/nginx/proxy-common.conf
COPY registries.conf clients.conf /etc/registry-cache/
COPY ui/ /app/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/tls.sh

EXPOSE 443 8080
VOLUME ["/data", "/certs"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

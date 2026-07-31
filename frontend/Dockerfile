FROM nginx:alpine
COPY frontend/ /usr/share/nginx/html/
# nginx.conf ships alongside the site files above but nginx:alpine doesn't load it from there on
# its own — without this it silently falls back to the image's default server block (no
# multi-domain routing, no rate limiting). Replaces the default vhost so it actually takes effect.
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

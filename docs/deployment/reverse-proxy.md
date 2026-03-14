# Reverse Proxy & HTTPS Setup

DeckDex MTG must sit behind a reverse proxy for internet exposure.
The proxy handles TLS termination, HTTP→HTTPS redirect, and forwards
requests to the backend (`:8000`) and frontend (`:5173` or built static).

## Option A: Caddy (recommended — automatic HTTPS)

```
# /etc/caddy/Caddyfile
deckdex.example.com {
    # API & WebSocket
    handle /api/* {
        reverse_proxy localhost:8000
    }
    handle /ws/* {
        reverse_proxy localhost:8000
    }

    # Frontend (Vite dev or built assets)
    handle {
        reverse_proxy localhost:5173
    }
}
```

Caddy auto-provisions Let's Encrypt certificates. No extra config needed.

## Option B: nginx + certbot

```nginx
# /etc/nginx/sites-available/deckdex
server {
    listen 80;
    server_name deckdex.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name deckdex.example.com;

    ssl_certificate     /etc/letsencrypt/live/deckdex.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/deckdex.example.com/privkey.pem;

    # Security headers (redundant with app middleware — belt & suspenders)
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;
    add_header Referrer-Policy strict-origin-when-cross-origin;

    # Global body limit (matches app middleware)
    client_max_body_size 25m;

    # API
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket
    location /ws/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    # Frontend
    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then:

```bash
sudo certbot --nginx -d deckdex.example.com
sudo systemctl reload nginx
```

## Environment variables for production

```bash
# .env (production)
DECKDEX_PROFILE=production
DECKDEX_CORS_ORIGINS=https://deckdex.example.com
JWT_SECRET_KEY=<random-64-char-secret>
DECKDEX_ADMIN_EMAIL=you@example.com
DATABASE_URL=postgresql://user:pass@localhost:5432/deckdex
```

The app detects `DECKDEX_PROFILE=production` and:
- Enables HSTS header
- Sets `Secure` flag on JWT cookies
- Switches to structured JSON logging on stderr

## Docker Compose (production)

When using `docker-compose.yml`, the proxy sits outside the compose stack:

```
Internet → Caddy/nginx (TLS) → docker network
                                  ├── backend:8000
                                  ├── frontend:5173
                                  └── postgres:5432
```

Ensure `docker-compose.yml` does **not** expose ports 8000/5173 to `0.0.0.0`
in production — bind to `127.0.0.1` only so traffic must flow through the proxy.

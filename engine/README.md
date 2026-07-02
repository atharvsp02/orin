# engine — self-hosted Cognee OSS

Runs the open-source `cognee/cognee` engine (REST API on `:8000`). **Not Cogwit.**

    cp .env.example .env    # fill in a PAID LLM key (free Gemini caps at ~20 generations/day)
    docker compose up -d

Port 8000 is bound to localhost only. Expose it to the bot/dashboard via a Cloudflare Tunnel —
never directly to the internet, since `/api/v1/auth/register` is public.

Multi-tenant isolation (`ENABLE_BACKEND_ACCESS_CONTROL=true`) works out of the box on the
file-based Kuzu + LanceDB stack persisted in the `cognee-data` volume.

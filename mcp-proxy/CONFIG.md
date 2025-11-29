# Configuration schema

Un fichier unique `config.json` avec une liste de listeners. Chaque entrée :
- `name` : identifiant du listener.
- `type` : `mcp_http` | `mcp_sse` | `openapi`.
- `host` / `port` : cible upstream.
- `target_host` / `target_port` : interface/port d’écoute du proxy (côté client).

Exemple :
```json
{
  "servers": [
    {
      "name": "mcp-http",
      "type": "mcp_http",
      "host": "host.docker.internal",
      "port": 8001,
      "target_host": "0.0.0.0",
      "target_port": 40001
    },
    {
      "name": "mcp-sse",
      "type": "mcp_sse",
      "host": "host.docker.internal",
      "port": 8002,
      "target_host": "0.0.0.0",
      "target_port": 40002
    },
    {
      "name": "openapi",
      "type": "openapi",
      "host": "host.docker.internal",
      "port": 8003,
      "target_host": "0.0.0.0",
      "target_port": 40003
    }
  ]
}
```

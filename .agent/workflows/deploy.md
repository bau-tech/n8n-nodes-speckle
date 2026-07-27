---
description: How to build and deploy the Speckle n8n node
---

# Deploying Speckle n8n Node

## Local Development (Testing in n8n)

1.  Build the project:
    ```bash
    npm run build
    ```

2.  Link the package locally:
    ```bash
    npm link
    ```

3.  Link to your n8n installation:
    *Navigate to your n8n custom nodes directory (typically `~/.n8n/custom`)*
    ```bash
    npm link n8n-nodes-speckle
    ```

4.  Restart n8n to see changes.

## Production Release (npm)

1.  Build the project:
    ```bash
    npm run build
    ```

2.  Publish to npm (requires login):
    ```bash
    npm publish
    ```

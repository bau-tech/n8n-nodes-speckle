# n8n-nodes-speckle

This is an n8n community node that integrates [Speckle](https://speckle.systems/) — the open-source data platform for AEC (Architecture, Engineering, Construction) — into n8n workflows.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

It exposes Speckle's GraphQL API as a node with 11 resources covering projects, models, versions, objects, comments, webhooks, and more, including BIM-specific helpers for IFC/Revit/Tekla metadata extraction and model analytics — plus a **Speckle Trigger** node that starts workflows on Speckle project events.

## Installation

### Prerequisites
- Node.js v18.17.0 or higher
- npm
- A Speckle account and a personal access token

### Install via npm

```bash
npm install n8n-nodes-speckle
```

Then follow n8n's guide for [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/).

### Development / local install

```bash
git clone <this-repository-url>
cd n8n-nodes-speckle

npm install
npm run build

# Link into your n8n custom nodes directory
npm link
mkdir -p ~/.n8n/custom
cd ~/.n8n/custom
npm init -y
npm link n8n-nodes-speckle

n8n start
```

## Configuration

1. Get a Speckle Personal Access Token:
   - Go to your Speckle server (e.g. `https://app.speckle.systems`)
   - Profile Settings → Developer Settings → New Token
   - Grant the scopes you need (e.g. `streams:read`, `profile:read`; add `tokens:write` if you'll use the Token resource)

2. In n8n, create a new credential of type **Speckle**:
   - **Speckle Server URL**: `https://app.speckle.systems` (or your self-hosted URL)
   - **Personal Access Token**: paste your token

The credential authenticates against the server's `/graphql` endpoint and is verified with an `activeUser` test query on save.

## Resources & Operations

| Resource | Operations |
|---|---|
| **Project** | Create, Update, Delete, Get, Get Many, Get By Name, Search, Get Team, Invite User, Update Role, Remove User, Leave, Get Activity, Import File, Download File, List Blobs, Transfer To Server, Export/Import Transfer Payload |
| **Model** | Create, Update, Delete, Get, Get Many, Get By Name, Transfer To Server, Export/Import Transfer Payload |
| **Version** | Create, Update, Delete, Get, Get Many, Diff, Move To Model, Mark Received, Transfer To Server, Export/Import Transfer Payload |
| **Object** | Create, Get Many, Query, Get Parameters, Filter Objects, Fetch Graph, Get Metadata, Flatten, Traverse, Validate IDs, Update Properties, Object Property Validation, Extract Metadata, Extract IFC Element Table, Extract Tekla Element Table, Extract Revit Element Table, Generate Model Analytics |
| **User** | Get Active User, Search |
| **Server** | Get |
| **Comment** | Create, Reply, Edit, Archive, Mark Viewed, Get Project Comments |
| **Webhook** | Create, Update, Delete, Get, Get Many, Test |
| **Token** | Create, Revoke |
| **Selection** | Get Selection (interactively pick a project / model / version) |
| **Viewer** | Get Embed Link, Get HTML Viewer |

There is also a separate **Speckle Trigger** node (see below) for starting workflows on Speckle events, instead of polling with the Webhook resource.

### Highlights

- **Create Object from raw JSON** — push an arbitrary JSON payload as a new Speckle object (with an optional new version pointing at it), without needing a source file or an existing object to copy.
- **BIM data extraction** — pull flattened, chart-ready tables from object graphs for IFC, Revit, and Tekla models, including category/parameter filtering.
- **Model analytics** — generate element-count analytics (beams, floors, columns, walls, etc.) for a version.
- **Property validation & updates** — validate object properties (equals, greater/less than, has value, true/false) and write updates back as a new version.
- **Cross-server transfer** — copy or export/import projects, models, and versions (with full object graphs) between Speckle servers.
- **Viewer embedding** — get an embeddable link or ready-to-use HTML snippet for the Speckle 3D viewer.
- **Debug logging** — an "Enable Debug Logging" toggle on the node logs GraphQL requests/responses (with the token masked) to the n8n console.
- **Return All pagination** — Project, Model, and Version "Get Many" operations have a "Return All" toggle that pages through the full cursor-based result set instead of capping at `Limit`.
- **Get By Name lookups** — find a Project or Model by its exact name, without needing to know its ID first.
- **Webhook Test** — send a synthetic test payload directly to a webhook's URL to verify connectivity/auth without waiting for a real Speckle event.

## Speckle Trigger

The **Speckle Trigger** node starts a workflow whenever a chosen event happens on a Speckle project (new version, new comment, branch changes, etc.). Unlike the Webhook resource on the main node (which requires you to manually create/delete the webhook and wire it to a generic n8n Webhook node), the trigger node manages the webhook's lifecycle automatically:

- **On activation**, it creates a Speckle webhook pointing at the workflow's production webhook URL.
- **On deactivation**, it deletes that webhook again.
- Each time the workflow runs, the raw Speckle webhook payload (`streamId`, `webhookId`, `event.event_name`, `event.data`) is passed through as the trigger's output.

Setup:
1. Add a **Speckle Trigger** node.
2. Select the **Project** to watch and the **Events** that should fire the workflow (defaults to `Version Created`). Available events, grouped by resource:
   - **Project**: Updated, Deleted, Access Granted, Access Removed, Invite Sent, Invite Accepted, Invite Declined, Access Requested, Access Request Declined
   - **Model**: Created, Updated, Deleted
   - **Version**: Created, Updated, Received, Deleted, Moved
   - **Comment**: Created, Archived, Reply, Mention
3. Activate the workflow — the webhook is created automatically. Deactivating the workflow removes it again.

> The dropdown labels use Speckle's current Project/Model/Version terminology, but under the hood these map to the server's legacy `stream_*`/`branch_*`/`commit_*` webhook trigger strings — confirmed against a live self-hosted server (speckle-server 2.31.14) that webhook triggers were deliberately kept on the old naming for backward compatibility, even though the public API itself now uses Project/Model/Version.
>
> There's no event for "a brand-new project was created" — Speckle webhooks are always attached to one already-existing project, so nothing can be listening before a project exists. There's no server-wide webhook to work around this.

> The Automation and Workspace resources were removed — they depend on Speckle modules (Automate, Workspaces) that aren't enabled on every self-hosted server and returned server-side errors when tested against one. If your server has these modules enabled and you'd like them back, they can be re-added.

## Example Usage

### List all projects
```
Manual Trigger → Speckle
  Resource: Project
  Operation: Get Many
```

### Extract a Revit element table
```
Manual Trigger → Speckle
  Resource: Object
  Operation: Extract Revit Element Table
  Project ID: your-project-id
  Version/Object ID: your-version-id
```

### React to a new model version (webhook)
See [workflows/speckle-new-model-webhook.json](workflows/speckle-new-model-webhook.json) for a ready-to-import workflow that listens for new versions via a Speckle webhook.

## Development

```bash
npm run build        # tsc + copy static assets (icons)
npm run watch         # tsc in watch mode
npm run lint          # type-check only (tsc --noEmit)
npm test              # run jest tests
npm run test:watch
npm run test:coverage
```

See [tests/](tests/) for the test suite, and [docs/](docs/) for deeper notes on the object-filtering implementation.

## Publishing

1. Update `package.json` (`name`, `author`, `repository`, `homepage`, `bugs`) with your own details.
2. `npm run build`
3. `npm link` and test the node inside a local n8n instance.
4. `npm publish`

## Resources

- [n8n Documentation](https://docs.n8n.io/)
- [n8n Community Nodes](https://docs.n8n.io/integrations/community-nodes/)
- [Speckle Documentation](https://speckle.guide/)
- [Speckle GraphQL API Explorer](https://app.speckle.systems/graphql)

## License

[MIT](LICENSE.md)

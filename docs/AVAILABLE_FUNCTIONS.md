# n8n-nodes-speckle — Available Functions Reference

This document catalogs every operation exposed by the **Speckle** n8n node (`nodes/Speckle/Speckle.node.ts`) and the separate **Speckle Trigger** node (`nodes/Speckle/SpeckleTrigger.node.ts`), the underlying GraphQL/REST calls and helper functions that power them, and a set of suggestions for functionality that could be added next.

The Speckle node exposes **11 resources**. Each resource has an `Operation` dropdown; the tables below list every operation, what it does, and the key input fields it needs.

---

## 1. Project

| Operation | Value | Description |
|---|---|---|
| Create | `create` | Create a new project |
| Update | `update` | Update a project's name/description/visibility |
| Delete | `delete` | Delete a project |
| Get | `get` | Get a project by ID |
| Get Many | `getAll` | List all accessible projects |
| Get By Name | `getByName` | Find a project by its exact name (case-insensitive) |
| Search | `search` | Search projects by name or description |
| Get Team | `getTeam` | List all collaborators and their roles |
| Invite User | `invite` | Invite a user to a project by email + role |
| Update Role | `updateRole` | Change (or revoke, via "Remove Access") a collaborator's role |
| Remove User | `remove` | Remove a user from a project |
| Leave | `leave` | Leave a project |
| Get Activity | `getActivity` | Get the project's activity stream |
| Import File | `importFile` | Upload and import a file (IFC, OBJ, etc.) into a model |
| Download File | `downloadFile` | Download a previously uploaded blob by ID |
| List Blobs | `listBlobs` | List all blobs (files) attached to a project |
| Transfer To Server | `transfer` | Copy the project (and selected model/version content) to another Speckle server in one call |
| Export Transfer Payload | `exportPayload` | Export the project as a portable JSON payload for a second node/run to import |
| Import Transfer Payload | `importPayload` | Import a payload produced by "Export Transfer Payload" |

Accepts a project URL or raw ID in the Project ID field (`cleanSpeckleId()` strips `https://.../projects/<id>` down to `<id>`).

---

## 2. Model

| Operation | Value | Description |
|---|---|---|
| Create | `create` | Create a new model in a project |
| Update | `update` | Update a model's name/description |
| Get | `get` | Get a model by ID |
| Get Many | `getAll` | List all models in a project |
| Get By Name | `getByName` | Find a model by its exact name within a project (case-insensitive) |
| Delete | `delete` | Delete a model |
| Transfer To Server | `transfer` | Copy the model and its versions to another server |
| Export Transfer Payload | `exportPayload` | Export the model as a portable payload |
| Import Transfer Payload | `importPayload` | Import a model payload |

---

## 3. Version

| Operation | Value | Description |
|---|---|---|
| Create | `create` | Create a new version/commit pointing at an object |
| Get Many | `getAll` | List all versions for a model |
| Get | `get` | Get a single version by ID |
| Update | `update` | Update a version's message |
| Delete | `delete` | Delete a version |
| Diff | `diff` | Compare two versions and return added/removed/modified objects |
| Move To Model | `moveToModel` | Move one or more versions (comma-separated IDs) to a different model |
| Mark Received | `markReceived` | Mark a version as "received" by a downstream application (preserves source-app provenance) |
| Transfer To Server | `transfer` | Copy the version and its full object graph to another server |
| Export Transfer Payload | `exportPayload` | Export the version (with full object graph) as a portable payload |
| Import Transfer Payload | `importPayload` | Import a version payload |

`Diff` has a "Detailed Diff" toggle backed by `diffHelper.diffObjectsPaginated()`.

---

## 4. Object

This is the largest resource — most of the BIM-specific value-add lives here.

| Operation | Value | Description |
|---|---|---|
| Create | `create` | Create a new object from a raw JSON payload, optionally as a new version (`SpeckleClient.uploadObjects`) |
| Get Many | `getAll` | Get objects from a version |
| Query | `query` | Query objects by property path/value |
| Get Parameters | `getParameters` | Retrieve all parameters of a single object (beam, wall, etc.) |
| Filter Objects | `filterObjects` | Return objects matching a property filter |
| Fetch Graph | `fetchGraph` | Fetch the complete object graph (root + all referenced children) |
| Get Metadata | `getMetadata` | Get object metadata only, no geometry (fast) |
| Flatten | `flatten` | Export a flat list of all objects with simplified properties (`objectUtils.flattenObjectTree`) |
| Validate IDS | `validateIds` | Validate objects against an IDS (Information Delivery Specification) XML file (`idsValidator.validateObjectsAgainstIds`) |
| Traverse | `traverse` | Advanced object-tree traversal with filtering |
| Extract Metadata | `extractMetadata` | Extract a flattened metadata table from objects (Revit/Tekla/IFC generic) |
| Extract IFC Element Table | `extractElementTable` | Flat IFC element table — one row per element, IFC property sets as columns |
| Extract Tekla Element Table | `extractTeklaTable` | Flat Tekla Structures element table, with Tekla-specific filters + user properties |
| Extract Revit Element Table | `extractRevitTable` | Flat Revit element table, with category filtering + Revit parameter columns |
| Generate Model Analytics | `analyzeModel` | Chart-ready analytics: element counts by category (beams, floors, columns, walls, …) (`metadataExtractor.buildModelAnalytics`) |
| Object Property Validation | `validateProperties` | Validate object properties against rules: equals, greater than, smaller than, has value, true, false |
| Update Properties | `updateProperties` | Update specific properties of an object and optionally commit a new version |

`Create` accepts an "Object Data" JSON payload (e.g. `{ "name": "Sensor Reading", "value": 42 }`), defaults `speckle_type` to `"Base"` if omitted, computes the object ID as an MD5 hash of the JSON with sorted keys (excluding `id` and `__`-prefixed fields — the same scheme Speckle itself uses), and uploads it standalone (no parent tree). An "Also Create Version" toggle then points a new version at the uploaded object via the same `versionCreate` mutation used by Version → Create.

---

## 5. User

| Operation | Value | Description |
|---|---|---|
| Get Active User | `get` | Get the authenticated user's details |
| Search | `search` | Search users by name or email |

## 6. Server

| Operation | Value | Description |
|---|---|---|
| Get | `get` | Get server info (name, version, capabilities) |

## 7. Comment

| Operation | Value | Description |
|---|---|---|
| Create | `create` | Create a comment on a project/object |
| Reply | `reply` | Reply to an existing comment thread |
| Archive | `archive` | Archive a comment thread |
| Edit | `edit` | Edit an existing comment |
| Get Project Comments | `getProjectComments` | List comments for a project |
| Mark Viewed | `markViewed` | Mark a comment thread as viewed |

## 8. Webhook

| Operation | Value | Description |
|---|---|---|
| Create | `create` | Create a webhook (URL + trigger event types) for a project |
| Update | `update` | Update an existing webhook (URL, description, enabled, triggers) |
| Delete | `delete` | Delete a webhook |
| Get | `get` | Get a single webhook by ID |
| Get Many | `getAll` | List webhooks for a project |
| Test | `test` | Send a synthetic test payload to the webhook's URL to verify connectivity/auth |

> Note: this is a manual CRUD resource for managing webhooks directly. For automatically starting a workflow on Speckle events, use the separate **Speckle Trigger** node instead (see below).

## 9. Selection

| Operation | Value | Description |
|---|---|---|
| Get Selection | `getSelection` | Interactive project → model → version picker (cascading dropdowns via `loadOptionsMethod`) |

## 10. Viewer

| Operation | Value | Description |
|---|---|---|
| Get Embed Link | `getEmbedLink` | Get an embeddable URL for the Speckle 3D Viewer |
| Get HTML Viewer | `getHtmlViewer` | Get a ready-to-use `<iframe>` HTML snippet with the viewer embedded |

## 11. Token

| Operation | Value | Description |
|---|---|---|
| Create | `create` | Create a new personal API token |
| Revoke | `revoke` | Revoke (delete) an API token |

---

## 12. Speckle Trigger (separate node, `nodes/Speckle/SpeckleTrigger.node.ts`)

Unlike the Speckle node's resource/operation model above, **Speckle Trigger** is a dedicated `ITriggerNode` (group `trigger`) that manages a Speckle webhook automatically instead of requiring manual Webhook-resource CRUD.

| Parameter | Type | Description |
|---|---|---|
| Project | `options` (dynamic, `getProjects`) | The Speckle project to watch. The node creates and manages a webhook on this project automatically. |
| Events | `multiOptions` (default: Version Created) | Which project events should trigger the workflow. |

Event options use Speckle's current Project/Model/Version labels, but the underlying trigger `value` sent to the server is still the legacy `stream_*`/`branch_*`/`commit_*` action-type string — confirmed against a live speckle-server 2.31.14 instance: the server's public GraphQL API and internal event bus were renamed to Project/Model/Version, but webhook trigger strings were deliberately left unchanged for backward compatibility. There is no `project_*`/`model_*`/`version_*` webhook trigger naming to migrate to.

- **Project** (`stream_*`): Project Updated (`stream_update`), Project Deleted (`stream_delete`), Project Access Granted (`stream_permissions_add`), Project Access Removed (`stream_permissions_remove`), Project Invite Sent (`stream_invite_sent`), Project Invite Accepted (`stream_permissions_invite_accepted`), Project Invite Declined (`stream_invite_declined`), Project Access Requested (`stream_access_request_sent`), Project Access Request Declined (`stream_access_request_declined`)
- **Model** (`branch_*`): Model Created (`branch_create`), Model Updated (`branch_update`), Model Deleted (`branch_delete`)
- **Version** (`commit_*`): Version Created (`commit_create`), Version Updated (`commit_update`), Version Received (`commit_receive`), Version Deleted (`commit_delete`), Version Moved (`commit_move`)
- **Comment**: Comment Created (`comment_created`), Comment Archived (`comment_archived`), Comment Reply (`comment_replied`), Comment Mention (`comment_mention`)

**Not offered — "Project Created" (`stream_create`) and "Project Cloned" (`stream_clone`) are deliberately excluded.** There is no way to be notified when a brand-new project is created: Speckle webhooks (and this trigger) are always attached to one already-existing project (`webhookCreate` requires a `streamId`, and the schema confirms it only creates a webhook "on a stream"), but both of these events fire tagged with the *new* project's ID — which can't have a webhook attached before it exists. There's no server-wide/account-wide webhook to work around this; it's an architectural limitation of Speckle's webhook model, not something this node can fix.

Lifecycle: on workflow activation the node calls the `webhookCreate` mutation for the selected project and events, storing the resulting `webhookId`/`projectId` in workflow static data; on deactivation it calls `webhookDelete` to tear the webhook back down. Each time the workflow runs, the raw Speckle webhook payload (`streamId`, `webhookId`, `event.event_name`, `event.data`) is passed through as-is — the node does no additional filtering or mapping.

---

## Cross-cutting features

- **Debug logging** — an "Enable Debug Logging" toggle logs every GraphQL request/response to the n8n console with the auth token masked.
- **ID cleaning** — `cleanSpeckleId()` accepts either a raw ID or a full project/stream URL in ID fields.
- **Cross-server transfer** — `project`/`model`/`version` each support both a direct `Transfer To Server` (single node, second credential) and an `Export Transfer Payload` / `Import Transfer Payload` pair (two separate node calls, useful for cross-workflow or cross-execution transfers). Object graphs are walked and re-uploaded via `collectObjectGraph()` + `SpeckleClient.uploadObjects()`, and `sourceApplication` provenance is preserved via `Mark Received` on the destination version.
- **Return All pagination** — Project, Model, and Version `Get Many` (`getAll`) each have a "Return All" toggle that pages through the full cursor-based result set (via `findProjectByName`/`listProjectModels`-style internal cursor loops) instead of capping at `Limit`. Other `Get Many`/list-style operations (Object, Webhook, Comment, Search, Get Activity) still take a fixed `Limit` only.
- **Get By Name lookups** — Project and Model each expose a `Get By Name` operation (`getByName`, backed by the internal `findProjectByName`/`findModelByName` helpers already used by Transfer/Import Payload) to look up by exact, case-insensitive name instead of ID.

## Underlying building blocks (for anyone extending the node)

**`api/client.ts` (`SpeckleClient`)**
- `makeGraphQLRequestDirect` / `makeGraphQLRequest` — GraphQL calls (the latter includes retry/compatibility handling)
- `makeRestRequest` — REST calls (used for blobs/file import)
- `fetchObject`, `getObjectClosureIds`, `getObjectChildrenRest` — object graph retrieval
- `uploadObjects` — batch object upload for commits/transfers
- `getObjectMetadata`, `getObjectMetadataDynamic`, `queryObjectMetadata` — metadata-only retrieval paths

**`metadataExtractor.ts`**
- `isRealBIMElement`, `detectSourceApplicationId`, `normalizeElementCategory`
- `extractMetadataFromObject`, `extractElementRow`, `extractTeklaRow`, `extractRevitRow`
- `buildModelAnalytics`

**`utils/objectUtils.ts`** — `flattenProperties`, `flattenObjectTree`
**`utils/idsValidator.ts`** — `validateObjectsAgainstIds`
**`diffHelper.ts`** — `diffObjectsPaginated`

**GraphQL surface** (`graphql/queries.ts`, `graphql/mutations.ts`): 16 queries and 27 mutations wired up, covering projects, models, versions, users, server info, comments, webhooks, blobs, activity, and team.

---

## Ideas worth considering

Several gaps previously flagged in this doc have since been closed: a dedicated **Speckle Trigger** node now exists (see [section 12](#12-speckle-trigger-separate-node-nodesspecklespeckletriggernodets)), Project/Model/Version `Get Many` got a **Return All** pagination toggle, Project/Model got **Get By Name** lookups, Webhook got a **Test** operation, and Object got a **Create** operation for pushing raw JSON payloads. One idea remains open:

1. **Re-add Automate / Workspace resources, opt-in.** The README notes these were removed because they error on servers without those modules enabled. Since that's already known and scoped, re-adding them behind their own resource (so they simply don't appear/error unless selected) would restore functionality for servers that do have Automate/Workspaces on, without regressing the common case.

If this is worth pursuing, happy to scope and implement it.

# Filter Objects Debugging Guide

> This guide covers the current node UI (**Property to Search** dropdown, **Match Type**, **Search Value**/**Custom Property Name**) — see [filter-objects-guide.md](filter-objects-guide.md) for full parameter documentation. If you're on an older build, rebuild first (`npm run build`) — several "returns nothing" causes below were real bugs that are now fixed.

## Issue: "Always Returns Nothing"

### Root Cause Analysis

The Filter Objects / Query operations can return nothing for several reasons, roughly in order of how often they actually turn out to be the cause:

1. **Category/Family/Level values are in a different language than you searched for** — Speckle doesn't translate these; a German model has German categories (`Wände`, not `Walls`). This is the single most common real cause.
2. **You searched Speckle Type for an element type** (e.g. `Wall`) — on newer connectors, every element from one source app shares the same `speckleType`, so this can never match. Use `Category` instead.
3. **`Max Nodes To Inspect` is too low** — the traversal stops before reaching the objects you want.
4. **The property genuinely doesn't exist** for that object/connector (e.g. `Material` on Revit — see [filter-objects-guide.md](filter-objects-guide.md)).
5. **Wrong Project/Model/Version ID.**

Two additional causes were real bugs in older builds, now fixed:
- A preset path like `properties.family` failed to match new-schema objects that have `family` promoted to the top level (fixed — the resolver now checks both locations).
- `speckleType` (camelCase) comes back as an explicit `null` on newer connectors, not merely absent — the real value is in `speckle_type` (snake_case). Older builds only checked `undefined`, so this fallback never triggered; now both `null` and `undefined` trigger it.

### Debug Process

Check the n8n server console (or `journalctl -u n8n` if self-hosted) for these log messages when you run Filter Objects or Query:

```
[filterObjects] Fetching object metadata for filtering...
[filterObjects] Fetched 304 objects, now filtering...
[filterObjects] Searched 304 objects, found 0 matches
[filterObjects] Returning 0 objects
```

(Replace `filterObjects` with `query` if that's the operation you ran.)

**What these logs tell you:**

- **Fetched N objects**: how many objects were retrieved from the version's tree (capped by `Max Nodes To Inspect`).
- **Searched N objects, found M matches**: how many of those objects matched your Property to Search / Match Type / Search Value.
- **Returning N objects** *(filterObjects only)*: how many full objects are being sent to n8n.

### Common Issues & Solutions

#### Issue 1: Fetched 0 objects

**Cause**: The root object couldn't be resolved from the given Version ID.
**Solution**: Verify Project ID, Model ID, and Version ID with **Get Metadata** first.

#### Issue 2: Fetched > 0, found 0 matches

**Cause**: Your Property to Search / Match Type / Search Value combination doesn't match anything.
**Solutions**:

1. Switch to the **Query** operation — same search, but the response includes `totalObjects` and per-match detail.
2. Use **Get Parameters** on a sample object to see real property names and values (including their exact language/casing).
3. Switch **Match Type** from `Equals Value` to `Contains Value` first — real values are often longer/localized than expected.
4. If searching `Speckle Type`, switch to `Category` instead (see caveat above).

#### Issue 3: Fetched = maxNodesToInspect exactly, found 0

**Cause**: Hit the inspection limit before reaching the objects you want.
**Solution**: Increase `Max Nodes To Inspect` (try 5000–10000).

#### Issue 4: found > 0 but Returning 0 objects

This was a real bug in old builds; if you still see it, rebuild the node — it should not occur on the current version.

---

## Step-by-Step Debugging Workflow

### Step 1: Verify Basic Connectivity

```yaml
Resource: Object
Operation: Get Metadata
Project ID: your_project_id
Model ID: your_model_id
Version ID: your_version_id
```

If this doesn't work, your IDs are wrong — fix that before touching the filter itself.

### Step 2: Inspect Available Properties

```yaml
Resource: Object
Operation: Get Parameters
Project ID: your_project_id
Model ID: your_model_id
Version ID: your_version_id
```

Pick any real object ID from your model (e.g. one you can see in the Speckle viewer) and check its actual property names, casing, and **language** before assuming a preset is broken.

### Step 3: Use Query Operation (Not Filter Objects)

```yaml
Resource: Object
Operation: Query
Property to Search: Category
Match Type: Contains Value
Search Value: Wall
Max Nodes To Inspect: 1000
```

**Query returns:**

```json
{
  "versionId": "...",
  "referencedObjectId": "...",
  "sourceApplication": "Revit",
  "totalObjects": 304,
  "matches": [
    {
      "objectId": "02148bb6...",
      "matchedKey": "category",
      "matchedValue": "Wände",
      "speckleType": "Objects.Data.DataObject:Objects.Data.RevitObject",
      "category": "Wände"
    }
  ],
  "note": "Searched 304 objects from version metadata. Use Filter Objects operation to get full object data."
}
```

This tells you:
- `totalObjects`: how many objects were actually inspected.
- `matches[].matchedKey` / `matchedValue`: exactly what property and value matched, in the object's real language/casing.
- An empty `matches` array with `totalObjects > 0` means your search genuinely found nothing — go back to Step 2.

### Step 4: Test Different Match Types

Using `Property to Search: Category` as an example:

| Test | Match Type | Search Value | Meaning |
| --- | --- | --- | --- |
| Presence only | Property Exists (Any Value) | *(hidden)* | Returns every object that has a category at all, regardless of value. |
| Broad match | Contains Value | `Wall` | Matches `"Wall"`, `"Curtain Wall"`, `"Wände"` won't match here — wrong language |
| Localized match | Contains Value | `Wände` | Matches the German category |
| Exact match | Equals Value | `Walls` | Only matches if the value is precisely `"Walls"`, nothing more, nothing less |

### Step 5: Check Max Nodes Limit

If `totalObjects` from Query equals your `Max Nodes To Inspect`, you hit the limit — increase it and retry.

---

## Property to Search Examples by Source Application

### Revit Objects (newer DataObject-schema connector)

| Goal | Property to Search | Match Type | Search Value |
| --- | --- | --- | --- |
| By category | Category | Contains | `Walls` or localized equivalent |
| By family name | Family (Revit) | Equals | `Basic Wall` |
| By type | Type (Revit) | Contains | `Generic - 200mm` |
| By level | Level | Contains | `Level 1` |
| By parameter value | Custom Property (`properties.parameters.Fire Rating.value`) | Equals | `1 hour` |
| By Revit element ID | Custom Property (`properties.elementId`) | Equals | `12345` |

### Tekla Objects

| Goal | Property to Search | Match Type | Search Value |
| --- | --- | --- | --- |
| By profile | Custom Property (`properties.profile`) | Contains | `HEA200` |
| By material grade | Material | Contains | `S355` |
| By Report attribute | Custom Property (`properties.Report.ASSEMBLY_POS`) | Equals | `A-1` |

### IFC Objects

| Goal | Property to Search | Match Type | Search Value |
| --- | --- | --- | --- |
| By IFC type | IFC Type | Contains | `IfcWall` |
| By IFC class | Speckle Type | Contains | `Ifc` |
| By property set value | Custom Property (`properties.Pset_WallCommon.LoadBearing`) | Equals | `true` |

---

## Example Debugging Session (real, from a live project)

Goal: find all walls in a German-language Revit model.

### Attempt 1

```yaml
Property to Search: Speckle Type
Match Type: Contains Value
Search Value: Wall
```

**Result**: 0 matches (found 0 of 304 objects).

### Debug step: switch to Query, check what Speckle Type actually contains

```yaml
Property to Search: Speckle Type
Match Type: Property Exists (Any Value)
```

**Result** (via `totalObjects`/`matches`): every object resolves to either `Objects.Data.DataObject:Objects.Data.RevitObject` (all real elements — walls, doors, floors alike), or a non-element type like `Speckle.Core.Models.Instances.InstanceProxy`.

**Analysis**: Speckle Type doesn't distinguish element types on this connector — it's the same string for every Revit element regardless of category. Need a different field.

### Attempt 2: switch to Category

```yaml
Property to Search: Category
Match Type: Contains Value
Search Value: Wall
```

**Result**: still 0 matches.

### Debug step: Get Parameters on a wall visible in the Speckle viewer

**Result**: `"category": "Wände"` — the model is authored in German.

### Attempt 3 (corrected)

```yaml
Property to Search: Category
Match Type: Contains Value
Search Value: Wände
```

**Result**: 45 matches found! ✅

---

## Understanding Object Structure

Speckle objects' shape depends on the connector generation:

### Newer connectors (DataObject schema) — top-level fields

```json
{
  "id": "02148bb68680b27805d211c86f6bbe1b",
  "speckle_type": "Objects.Data.DataObject:Objects.Data.RevitObject",
  "speckleType": null,
  "applicationId": "f235f6c3-...",
  "name": "Wände - WS_WAL_CON_300",
  "category": "Wände",
  "family": "Basiswand",
  "type": "WS_WAL_CON_300",
  "level": "B_Dü_E00_OKRD",
  "properties": {
    "elementId": "3495000",
    "Parameters": {
      "Type Parameters": { "Andere": { "Familienname": { "value": "Basiswand", "name": "Familienname" } } },
      "Instance Parameters": { }
    }
  }
}
```

Search: `Category` / `Contains` / `Wände` — no `properties.` prefix needed, these are top-level.

### Older connectors — nested under `properties`

```json
{
  "id": "abc123",
  "speckle_type": "Objects.BuiltElements.Wall",
  "properties": {
    "category": "Walls",
    "family": "Basic Wall",
    "type": "Generic - 200mm"
  }
}
```

Search: still `Category` / `Contains` / `Walls` — the node checks both the top level and `properties` automatically, so the same preset works on both schema generations without you needing to know which one you have.

### Deeply nested Revit parameters (either generation)

```json
{
  "properties": {
    "Parameters": {
      "Instance Parameters": {
        "GroupName": {
          "Fire Rating": { "value": "2 hour", "name": "Fire Rating" }
        }
      }
    }
  }
}
```

Search: `Custom Property` / `properties.Parameters.Instance Parameters.GroupName.Fire Rating.value` / `Equals` / `2 hour`

---

## Best Practices

1. **Always start with Query** — see exactly what's being found (and its real language/casing) before switching to Filter Objects.
2. **Use Get Parameters on a known object first** — don't guess property names or their language.
3. **Prefer Contains over Equals** until you've confirmed the exact value.
4. **If searching for an element type, use Category — never Speckle Type.**
5. **Increase Max Nodes gradually** — start at 1000, raise only if `totalObjects` from Query hits your limit.
6. **Check console logs** (`journalctl -u n8n` for self-hosted) — they show fetched/searched/found counts directly.

---

## Quick Diagnosis Checklist

- [ ] Verified Project/Model/Version IDs (test with Get Metadata)
- [ ] Checked real property names **and language** using Get Parameters
- [ ] Tested with Query operation first
- [ ] Confirmed `totalObjects > 0` in the Query response
- [ ] Increased Max Nodes To Inspect if hitting the limit
- [ ] Tried Contains before Equals
- [ ] Used Category (not Speckle Type) to search by element type
- [ ] Rebuilt the node if on an older build (`npm run build`)

---

## Still Not Working?

If Filter Objects still returns nothing after following this guide, share:

1. The console log lines (`[filterObjects] Fetched X objects... Searched X objects, found Y matches`)
2. The result from **Get Parameters** on an object you can see in the Speckle viewer
3. Your exact Property to Search / Match Type / Search Value
4. What you expected to find (e.g. "I can see 10 walls in the Speckle viewer")

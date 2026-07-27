# Filter Objects by Property - User Guide

## Overview

The **Filter Objects** operation (`resource: object`, `operation: filterObjects`) searches through a Speckle model version and returns only the objects that match a property criterion — useful for extracting specific types of objects (walls, doors, beams, …) or objects with particular property values. The **Query** operation runs the exact same search but returns lightweight match metadata instead of the full objects, for debugging/exploration.

> This guide reflects the current node UI (a structured **Property to Search** dropdown, **Match Type**, and **Search Value**/**Custom Property Name** fields) — not a free-text query string. If you're looking at an older version of this doc that references a single `Property Query: speckle_type:Wall` field, that interface no longer exists.

## How It Works

1. Resolves the version's referenced root object and fetches metadata for every object in its tree (up to **Max Nodes To Inspect**), skipping pure geometry.
2. For each object, resolves the selected property (checking the top level, then inside `properties`, then falling back between the two — see [Schema notes](#schema-notes-datobject-vs-older-connectors) below).
3. Compares the resolved value against **Search Value** using the selected **Match Type**.
4. **Filter Objects** returns the matching objects themselves; **Query** returns match metadata only.

## Configuration

### Required Parameters

| Parameter | Description | Example |
| --- | --- | --- |
| **Project ID** | The Speckle project ID | `abc123def456` |
| **Model ID** | The model ID within the project | a model ID (not a name) |
| **Version ID** | The specific version ID | a version ID |
| **Property to Search** | Preset dropdown — see table below | `Category` |
| **Custom Property Name** | Only shown when Property to Search = `Custom Property` | `Fire Rating` |
| **Match Type** | `Property Exists (Any Value)` / `Contains Value` / `Equals Value` | `Contains Value` |
| **Search Value** | Only shown for Contains/Equals | `Wände` |

### Optional Parameters

| Parameter | Default | Description |
| --- | --- | --- |
| **Max Nodes To Inspect** | `1000` | Maximum number of objects to traverse (raise for large models — see [Common Mistakes](#troubleshooting)) |

---

## Property to Search presets

| Dropdown option | Resolves | Works on... |
| --- | --- | --- |
| **Category** | `category` | Both schema generations — always top-level. |
| **Speckle Type** | `speckleType` (aliased to `speckle_type`) | Mechanically always works, but **cannot distinguish element types** on newer connectors — see caveat below. |
| **Family (Revit)** | `family` (falls back to `properties.family`) | Both generations. |
| **Type (Revit)** | `type` (falls back to `properties.type`) | Both generations. |
| **IFC Type** | `ifcType` (falls back to `properties.ifcType`) | Both generations (not verified against live IFC data — no IFC connector project was available to test against, only Revit). |
| **Material** | `properties.material` | **Tekla only.** Revit doesn't expose a simple material field — material data lives inside a nested `Material Quantities` structure per material layer, which this preset can't reach. |
| **Level** | `level` (falls back to `properties.level`) | Both generations. |
| **Custom Property** | Whatever path you type in **Custom Property Name** | Anything — dot notation supported (e.g. `properties.parameters.FireRating`). |

### Schema notes: DataObject vs. older connectors

Newer Speckle connectors (the "DataObject" schema) promote `family`, `type`, `level`, `category`, and `ifcType` to **top-level** siblings of `speckleType`, whereas older connectors nested them under `properties`. The node checks both locations automatically, so presets work either way — you don't need to know which schema generation your project uses.

One real, confirmed quirk: on newer connectors, `speckleType` (camelCase) comes back as an explicit `null` — the actual value lives in `speckle_type` (snake_case). The node checks both; you never need to type the snake_case version yourself.

### ⚠️ Speckle Type no longer identifies element type

On newer connectors, **every BIM element from the same source application shares one `speckleType`** — e.g. every Revit wall, door, and column alike is `Objects.Data.DataObject:Objects.Data.RevitObject`. Searching Speckle Type for `"Wall"` will find **zero** results, no matter the Match Type, because the string "Wall" simply doesn't appear anywhere in that value anymore.

**Use `Category` instead** to filter by element type. Speckle Type is still useful for a different purpose: separating real BIM elements from non-element objects in the tree, e.g. `Contains` / `InstanceProxy` to find instance placeholders, or `Contains` / `Collection` to find organizational folder nodes.

### ⚠️ Category values are in the model's authoring language

`category` holds whatever string the source application's UI uses — if a Revit model was authored in German, categories are German (`Wände`, `Türen`, `Geschossdecken`), not English (`Walls`, `Doors`, `Floors`). There's no server-side translation. Use **Get Parameters** on a sample object first if you don't know the model's language, or use **Contains** with a short language-appropriate fragment.

If you need locale-independent category filtering, use the dedicated **Extract Revit Element Table** operation instead — its Category dropdown matches against Revit's internal `BuiltInCategory` (`OST_Walls`, etc.), which is the same regardless of the model's UI language, and only falls back to the literal category string if that fails.

---

## Confirmed real-world example (German Revit project, 304 objects / 113 real elements)

| Preset | Match Type | Search Value | Result |
| --- | --- | --- | --- |
| Category | Contains | `Wände` | ✅ finds all walls |
| Category | Contains | `Türen` | ✅ finds all doors |
| Family (Revit) | Equals | `Basiswand` | ✅ finds all "Basic Wall" family instances |
| Type (Revit) | Contains | `WS_WAL_CON` | ✅ finds all wall type variants sharing that project-specific type-code prefix |
| Level | Contains | `E00` | ✅ finds everything on this project's ground-floor level code |
| Speckle Type | Contains | `Wall` | ❌ 0 results — see caveat above |
| Material | Contains | *(anything)* | ❌ 0 results on this Revit project — expected, see caveat above |

---

## Match Type reference

| Match Type | Behavior |
| --- | --- |
| **Property Exists (Any Value)** | Returns objects that have any (non-null, non-empty) value for the selected property — **Search Value** is hidden and ignored. Good for "which objects have this field at all?" |
| **Contains Value** | Case-insensitive substring match. `Wände` matches `"Wände"`; `Wall` also matches `"Curtain Wall"`, `"Retaining Wall"`. This is the right default for category/family/type names, since real values are often longer or localized strings. |
| **Equals Value** | Exact case-insensitive match. Use only when you know the value precisely, e.g. an exact family name like `Basiswand`. |

**Custom Property** with dot notation still works exactly as before for anything not covered by a preset, e.g.:
- `properties.parameters.Fire Rating.value` (nested Revit parameter)
- `properties.Report.VOLUME` (Tekla quantity)
- `elements.0.id` (numeric array index)

---

## Real-World Examples

### Example 1: Extract all walls (localized category)

```yaml
Resource: Object
Operation: Filter Objects
Project ID: YOUR_PROJECT_ID
Model ID: YOUR_MODEL_ID
Version ID: YOUR_VERSION_ID
Property to Search: Category
Match Type: Contains Value
Search Value: Wände   # or "Walls" if the model is in English
Max Nodes To Inspect: 5000
```

**Output:** array of all wall objects.

### Example 2: Find a specific Revit family

```yaml
Property to Search: Family (Revit)
Match Type: Equals Value
Search Value: Basiswand
```

### Example 3: Find fire-rated elements (custom nested property)

```yaml
Property to Search: Custom Property
Custom Property Name: properties.parameters.Fire Rating.value
Match Type: Equals Value
Search Value: 1 hour
```

### Example 4: Check which objects have a given field at all

```yaml
Property to Search: Custom Property
Custom Property Name: properties.area
Match Type: Property Exists (Any Value)
```

Then use a downstream node to filter by `area > 50`.

### Example 5: Separate real elements from instance placeholders

```yaml
Property to Search: Speckle Type
Match Type: Contains Value
Search Value: InstanceProxy
```

---

## Query vs. Filter Objects

### Query Operation

- Returns: `{ versionId, referencedObjectId, sourceApplication, totalObjects, matches: [{ objectId, matchedKey, matchedValue, speckleType, category }], note }`
- Use when: you want to see match metadata (which objects matched, their type/category) without pulling full object data.
- Good for: debugging, exploration, confirming a query before switching to Filter Objects.

### Filter Objects Operation

- Returns: `[object1, object2, object3, ...]` — the full matched objects.
- Use when: you need the actual object data for downstream processing.
- Good for: production workflows, data extraction, analysis pipelines.

---

## Troubleshooting

### Issue: No results returned

1. **Try Query first** — its `totalObjects` field tells you how many objects were actually inspected, and `matches` shows exactly what matched.
2. **Switch Match Type from Equals to Contains** — real values (especially category/family) are often longer or differently-cased than expected.
3. **Check the model's authoring language** — categories, families, and levels are not translated; a German model needs German search terms.
4. **Verify the property actually exists** on a sample object using **Get Parameters**.
5. **Increase Max Nodes To Inspect** if the model is large — objects past the limit are never inspected.
6. **Don't use Speckle Type to search for an element type** — use Category instead (see caveat above).

### Issue: Too many results

1. Make the query more specific: `Equals Value` instead of `Contains Value`, or a longer search string.
2. Chain multiple Filter Objects nodes.
3. Use downstream IF/Filter nodes for additional filtering (e.g. on a nested property this operation doesn't expose as a preset).

### Issue: Timeout or slow performance

1. Reduce **Max Nodes To Inspect**.
2. Filter in stages (multiple Filter Objects nodes, each narrowing further).

---

## Common Use Cases

| Use Case | Property to Search | Match Type | Search Value |
| --- | --- | --- | --- |
| Extract all walls | Category | Contains | `Walls` (or localized equivalent) |
| Find a Revit family | Family (Revit) | Equals | exact family name |
| Get objects by level | Level | Contains | level name/code |
| Isolate instance placeholders | Speckle Type | Contains | `InstanceProxy` |
| Fire rating / custom parameter | Custom Property | Equals | parameter value |
| Find objects with any value for a field | any preset or Custom Property | Property Exists (Any Value) | *(hidden)* |

---

## Next Steps

After filtering objects, you can:

- **Export to CSV/JSON** using n8n's data transformation nodes
- **Send to database** (PostgreSQL, MongoDB, etc.)
- **Generate reports** with aggregated statistics
- **Trigger notifications** based on object properties
- **Feed into IDS validation** workflow
- **Create custom dashboards** with filtered data

---

## Example n8n Workflow

```json
{
  "nodes": [
    {
      "name": "Speckle - Filter Walls",
      "type": "CUSTOM.speckle",
      "parameters": {
        "resource": "object",
        "operation": "filterObjects",
        "projectId": "abc123",
        "modelId": "your-model-id",
        "versionId": "your-version-id",
        "propertyToSearch": "category",
        "matchType": "contains",
        "searchValue": "Wände",
        "maxNodesToInspect": 2000
      }
    },
    {
      "name": "Export to CSV",
      "type": "n8n-nodes-base.spreadsheetFile"
    }
  ]
}
```

This example extracts all wall objects (by their localized category) and exports the result to CSV.

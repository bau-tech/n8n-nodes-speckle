# Filter Objects - Quick Reference

> Field names below match the current node UI: **Property to Search** (dropdown), **Match Type**, **Search Value** / **Custom Property Name**. See [filter-objects-guide.md](filter-objects-guide.md) for full docs and [filter-objects-debugging.md](filter-objects-debugging.md) if you're getting nothing.

## Match Type cheat sheet

| Match Type | Behavior |
| --- | --- |
| **Property Exists (Any Value)** | Has any non-empty value — Search Value hidden. |
| **Contains Value** | Case-insensitive substring — **use this by default.** |
| **Equals Value** | Exact case-insensitive match — only when you know the value precisely. |

## Common Property to Search presets

| Want to find... | Property to Search | Match Type | Search Value |
| --- | --- | --- | --- |
| All walls | `Category` | Contains | `Walls` (or localized — see below) |
| All doors | `Category` | Contains | `Doors` |
| Specific level | `Level` | Contains | `Level 1` |
| Specific family | `Family (Revit)` | Equals | `Basic Wall` |
| By material (Tekla only) | `Material` | Contains | `Concrete` |
| Fire-rated elements | `Custom Property` → `properties.parameters.Fire Rating.value` | Equals | `1 hour` |
| External elements | `Custom Property` → `properties.isExternal` | Property Exists | *(hidden)* |
| Structural members | `Category` | Contains | `Structural` |
| Tekla by profile | `Custom Property` → `properties.profile` | Contains | `HEA200` |
| IFC type | `IFC Type` | Contains | `IfcWall` |

## ⚠️ Two presets that need special handling

- **Speckle Type** — on newer connectors, *every* element from one source app shares the same value (e.g. every Revit element is `Objects.Data.DataObject:Objects.Data.RevitObject`). It can't find "walls" — **use Category instead**. Speckle Type is still useful for isolating non-element objects (`Contains` / `InstanceProxy`, `Contains` / `Collection`).
- **Material** — only populated for Tekla. Revit doesn't expose a simple material field (it's nested per-layer under `Material Quantities`), so this preset always returns 0 on Revit regardless of search value.

## ⚠️ Category/Family/Level are not translated

They hold whatever string the source app's UI language uses. A German Revit model has `Wände`, not `Walls`; `Türen`, not `Doors`. If Contains/Equals against the English term finds nothing, run **Get Parameters** on a known object first to see the real value.

## Debugging Checklist (If Getting Nothing)

1. ✅ **Test basic connectivity**: use **Get Metadata** to verify your IDs
2. ✅ **Inspect real properties**: use **Get Parameters** to see actual names *and language*
3. ✅ **Use Query first**: switch from Filter Objects to Query — its response includes `totalObjects` and per-match detail
4. ✅ **Check console logs**: look for `[filterObjects] Fetched X objects... Searched X objects, found Y matches`
5. ✅ **Try Contains before Equals**
6. ✅ **Increase Max Nodes To Inspect** to 5000+ if the model is large
7. ✅ **Not Speckle Type for element type** — switch to Category

## Common Mistake Patterns

| ❌ Wrong | ✅ Correct | Why |
| --- | --- | --- |
| `Speckle Type` / Contains / `Wall` | `Category` / Contains / `Walls` (or localized) | Speckle Type is the same value for every element on newer connectors |
| `Category` / Equals / `Walls` on a German model | `Category` / Contains / `Wände` | Category values aren't translated |
| `Material` / any value, on Revit | Use `Extract Revit Element Table` and read `Material Quantities` | Revit has no simple top-level material field |
| Max Nodes: 100 | Max Nodes: 1000–5000 | Too small a limit misses objects entirely |

## Property Paths by Source (for Custom Property)

### Revit
- Top-level: `category`, `family`, `type`, `level` (no `properties.` prefix needed — the node checks both locations automatically)
- `properties.parameters.{ParamName}.value` (v2) or `properties.Parameters.Instance Parameters.{GroupName}.{ParamName}.value` (v3)
- `properties.elementId`, `properties.worksetId`

### Tekla
- `properties.profile`, `properties.material`
- `properties.Report.{AttributeName}`
- `properties.User Defined Attributes.{AttributeName}`

### IFC
- `ifcType`, `tag` (top-level on newer connectors)
- `properties.{PropertySetName}.{PropertyName}`

## Quick Test Query

To verify Filter Objects/Query is working at all:

```yaml
Property to Search: Speckle Type
Match Type: Property Exists (Any Value)
Max Nodes: 1000
```

This should return (or match, via Query) essentially every object — since `speckleType`/`speckle_type` exists on all Speckle objects. If this finds nothing, the issue is your Project/Model/Version IDs, not the query.

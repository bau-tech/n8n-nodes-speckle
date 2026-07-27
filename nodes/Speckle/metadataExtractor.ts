/**
 * Helper functions for extracting and flattening metadata from Speckle objects
 * based on source application (Revit, Tekla, IFC)
 */

/**
 * Determines if an object is a "real" BIM element (not a container or data structure)
 * Filters out: DataChunk, Collection, Base objects, and other non-element types
 */
export function isRealBIMElement(obj: any): boolean {
	if (!obj) return false;
	
	const speckleType = obj.speckleType || obj.speckle_type || '';
	
	// If no speckleType at all, check if it has properties (might still be valid)
	if (!speckleType) {
		return obj.properties != null;
	}
	
	// Exclude only known container/structural types that are definitely NOT elements
	const excludePatterns = [
		'Speckle.Core.Models.DataChunk',
		'Speckle.Core.Models.Collection',
		'Objects.Other.RenderMaterial',
		'Objects.Other.BlockDefinition',
		// New DataObject-schema (v3 connectors): Instances reference a shared Definition proxy
		// for geometry reuse (e.g. repeated Revit families, Rhino blocks) — these are placeholder/
		// relationship objects, not semantic BIM elements, and carry no category/family/type data.
		'Speckle.Core.Models.Instances.InstanceProxy',
		'Speckle.Core.Models.Instances.InstanceDefinitionProxy',
	];
	
	// Check if type matches any exclude pattern
	for (const pattern of excludePatterns) {
		if (speckleType.includes(pattern)) {
			return false;
		}
	}
	
	// If it's not excluded, it's probably a real element
	// This is more permissive and will catch Tekla, Revit, IFC, and other elements
	return true;
}

export type SourceApplicationId = 'revit' | 'tekla' | 'ifc' | 'generic';

export interface ExtractElementRowOptions {
	sourceApplication?: string;
	includeUserProperties?: boolean;
	includeInstanceParams?: boolean;
	includeTypeParams?: boolean;
}

export interface AnalyticsCountRow {
	label: string;
	count: number;
	percentage: number;
}

export interface ModelAnalyticsResult {
	summary: {
		totalElements: number;
		groupedCategoryCount: number;
		rawCategoryCount: number;
		sourceApplication: string;
		sourceApplicationId: SourceApplicationId;
		topCategory: string | null;
		isPartialAnalysis: boolean;
		analyzedElementLimit: number | null;
	};
	categories: AnalyticsCountRow[];
	rawCategories: AnalyticsCountRow[];
	disciplines: AnalyticsCountRow[];
	charts: {
		categoryBar: { type: string; labels: string[]; datasets: Array<Record<string, any>> };
		categoryPie: { type: string; labels: string[]; datasets: Array<Record<string, any>> };
		disciplineDoughnut: { type: string; labels: string[]; datasets: Array<Record<string, any>> };
	};
}

/**
 * Detect the source application family for an object using version metadata and object type.
 */
export function detectSourceApplicationId(
	obj: any,
	sourceApplication?: string,
): SourceApplicationId {
	const normalizedSource = String(sourceApplication ?? obj?.sourceApplication ?? '').toLowerCase();
	const speckleType = String(obj?.speckle_type || obj?.speckleType || '').toLowerCase();

	if (
		normalizedSource.includes('revit') ||
		speckleType.includes('revitobject') ||
		speckleType.includes('.revit.')
	) {
		return 'revit';
	}

	if (
		normalizedSource.includes('tekla') ||
		speckleType.includes('teklaobject') ||
		speckleType.includes('teklastructures')
	) {
		return 'tekla';
	}

	if (
		normalizedSource.includes('ifc') ||
		speckleType.includes('.ifc.') ||
		// New DataObject-schema IFC connector: "Objects.Data.DataObject:Objects.Data.IfcObject"
		speckleType.includes('ifcobject') ||
		obj?.ifcType ||
		obj?.properties?.ifcType
	) {
		return 'ifc';
	}

	return 'generic';
}

/**
 * Intelligently extracts and flattens metadata from a Speckle object based on source application
 */
export function extractMetadataFromObject(
	obj: any,
	sourceApplication: string | undefined,
	includeGeometry: boolean,
	flattenNested: boolean,
	propertyPrefix: string
): Record<string, any> {
	const result: Record<string, any> = {};

	// Core properties (always included)
	result.id = obj.id;
	result.speckleType = obj.speckleType || obj.speckle_type;
	result.sourceApplication = sourceApplication || 'Unknown';
	result.category = obj.category;

	const sourceApplicationId = detectSourceApplicationId(obj, sourceApplication);

	// Application-specific extraction
	if (sourceApplicationId === 'revit') {
		extractRevitMetadata(obj, result, flattenNested, propertyPrefix);
	} else if (sourceApplicationId === 'tekla') {
		extractTeklaMetadata(obj, result, flattenNested, propertyPrefix);
	} else if (sourceApplicationId === 'ifc') {
		extractIFCMetadata(obj, result, flattenNested, propertyPrefix);
	} else {
		// Generic extraction for unknown sources
		extractGenericMetadata(obj, result, flattenNested, propertyPrefix);
	}

	// Include geometry properties if requested
	if (includeGeometry) {
		if (obj.properties?.Volume !== undefined) result.Volume = obj.properties.Volume;
		if (obj.properties?.Area !== undefined) result.Area = obj.properties.Area;
		if (obj.properties?.Length !== undefined) result.Length = obj.properties.Length;
	}

	return result;
}

/**
 * Extract Revit-specific metadata
 * Structure: Can be top-level OR properties.Instance Parameters, properties.Type Parameters
 * The API may return flattened structure with fields at top level
 */
function extractRevitMetadata(
	obj: any,
	result: Record<string, any>,
	flattenNested: boolean,
	propertyPrefix: string
) {
	// Revit-specific fields - check both top-level and properties
	result.family = obj.family || obj.properties?.family;
	result.type = obj.type || obj.properties?.type;
	result.level = obj.level || obj.properties?.level;

	// Extract from top-level parameters object (flattened API response)
	if (obj.parameters) {
		const prefix = propertyPrefix === 'source' ? 'revit_' : 
					propertyPrefix === 'path' ? 'parameters_' : '';
		for (const [key, value] of Object.entries(obj.parameters)) {
			result[`${prefix}${key}`] = extractParameterValue(value);
		}
	}

	// Instance Parameters (nested structure)
	if (obj.properties?.['Instance Parameters']) {
		if (flattenNested) {
			const prefix = propertyPrefix === 'source' ? 'revit_' : 
						propertyPrefix === 'path' ? 'Instance_Parameters_' : '';
			for (const [key, value] of Object.entries(obj.properties['Instance Parameters'])) {
				result[`${prefix}${key}`] = extractParameterValue(value);
			}
		} else {
			result['Instance Parameters'] = obj.properties['Instance Parameters'];
		}
	}

	// Type Parameters (nested structure)
	if (obj.properties?.['Type Parameters']) {
		if (flattenNested) {
			const prefix = propertyPrefix === 'source' ? 'revit_type_' : 
						propertyPrefix === 'path' ? 'Type_Parameters_' : '';
			for (const [key, value] of Object.entries(obj.properties['Type Parameters'])) {
				result[`${prefix}${key}`] = extractParameterValue(value);
			}
		} else {
			result['Type Parameters'] = obj.properties['Type Parameters'];
		}
	}

	// Material Quantities
	if (obj.properties?.['Material Quantities']) {
		if (flattenNested) {
			for (const [material, quantities] of Object.entries(obj.properties['Material Quantities'])) {
				if (typeof quantities === 'object' && quantities !== null) {
					for (const [qKey, qValue] of Object.entries(quantities as Record<string, any>)) {
						result[`Material_${material}_${qKey}`] = qValue;
					}
				}
			}
		} else {
			result['Material Quantities'] = obj.properties['Material Quantities'];
		}
	}
}

/**
 * Extract Tekla-specific metadata
 * Structure: Can be top-level OR properties.Report (contains all Tekla properties)
 */
function extractTeklaMetadata(
	obj: any,
	result: Record<string, any>,
	flattenNested: boolean,
	propertyPrefix: string
) {
	// Tekla-specific fields - check both top-level and properties
	result.profile = obj.profile || obj.properties?.profile;
	result.material = obj.material || obj.properties?.material;

	// Report properties
	if (obj.properties?.Report) {
		if (flattenNested) {
			const prefix = propertyPrefix === 'source' ? 'tekla_' : 
						propertyPrefix === 'path' ? 'Report_' : '';
			for (const [key, value] of Object.entries(obj.properties.Report)) {
				// Tekla Report properties can be objects with 'value' field
				result[`${prefix}${key}`] = extractParameterValue(value);
			}
		} else {
			result.Report = obj.properties.Report;
		}
	}

	// User Defined Attributes - check both top-level and properties
	const udaSource = obj.userDefinedAttributes || obj.properties?.userDefinedAttributes;
	if (udaSource) {
		if (flattenNested) {
			const prefix = propertyPrefix === 'source' ? 'tekla_uda_' : 
						propertyPrefix === 'path' ? 'UDA_' : '';
			for (const [key, value] of Object.entries(udaSource)) {
				result[`${prefix}${key}`] = extractParameterValue(value);
			}
		} else {
			result.userDefinedAttributes = udaSource;
		}
	}
}

/**
 * Extract IFC-specific metadata
 *
 * Old schema: ifcType/tag nested under properties, Psets grouped under a
 * `properties['Property Sets']` wrapper object.
 * New DataObject-schema IFC connector: ifcType/tag are top-level siblings of speckleType,
 * and Psets are typically nested directly under `properties` (e.g. `properties.Pset_WallCommon.FireRating`)
 * with no intermediate "Property Sets" wrapper — so both shapes are checked here.
 */
function extractIFCMetadata(
	obj: any,
	result: Record<string, any>,
	flattenNested: boolean,
	propertyPrefix: string
) {
	// IFC-specific fields — top-level (new schema) first, then nested (old schema)
	result.ifcType = obj.ifcType ?? obj.properties?.ifcType;
	result.tag = obj.tag ?? obj.properties?.tag;

	const flattenPsets = (psets: Record<string, any>) => {
		for (const [psetName, pset] of Object.entries(psets)) {
			if (typeof pset === 'object' && pset !== null) {
				const prefix = propertyPrefix === 'source' ? 'ifc_' :
							propertyPrefix === 'path' ? `${psetName}_` : '';
				for (const [propKey, propValue] of Object.entries(pset as Record<string, any>)) {
					result[`${prefix}${propKey}`] = extractParameterValue(propValue);
				}
			}
		}
	};

	const excludeKeys = ['Property Sets', 'ifcType', 'tag'];

	// Property Sets (Psets)
	if (obj.properties?.['Property Sets']) {
		if (flattenNested) {
			flattenPsets(obj.properties['Property Sets']);
		} else {
			result['Property Sets'] = obj.properties['Property Sets'];
		}
	} else if (flattenNested && obj.properties) {
		// New schema: no "Property Sets" wrapper — any nested object directly under
		// `properties` is itself a property set (e.g. properties.Pset_WallCommon.FireRating)
		const nestedPsets: Record<string, any> = {};
		for (const [key, value] of Object.entries(obj.properties)) {
			if (!excludeKeys.includes(key) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
				nestedPsets[key] = value;
			}
		}
		flattenPsets(nestedPsets);
	}

	// Generic IFC properties (top-level scalars under properties)
	if (obj.properties) {
		for (const [key, value] of Object.entries(obj.properties)) {
			if (!excludeKeys.includes(key) && typeof value !== 'object') {
				result[key] = value;
			}
		}
	}
}

/**
 * Extract metadata from unknown/generic sources
 */
function extractGenericMetadata(
	obj: any,
	result: Record<string, any>,
	flattenNested: boolean,
	propertyPrefix: string
) {
	// Try to extract common fields
	if (obj.properties) {
		for (const [key, value] of Object.entries(obj.properties)) {
			if (typeof value !== 'object' || value === null) {
				result[key] = value;
			} else if (flattenNested) {
				// Recursively flatten nested objects
				flattenObject(value, result, key, propertyPrefix);
			}
		}
	}

	// Also check top-level parameters
	if (obj.parameters) {
		const prefix = propertyPrefix === 'path' ? 'parameters_' : '';
		for (const [key, value] of Object.entries(obj.parameters)) {
			result[`${prefix}${key}`] = extractParameterValue(value);
		}
	}
}

/**
 * Extract value from parameter object (handles {value: X, units: Y} format)
 */
function extractParameterValue(param: any): any {
	if (param === null || param === undefined) return null;
	if (typeof param !== 'object') return param;
	if ('value' in param) return param.value;
	return param;
}

/**
 * Recursively flatten nested objects
 */
function flattenObject(
	obj: any,
	result: Record<string, any>,
	prefix: string,
	prefixMode: string
) {
	for (const [key, value] of Object.entries(obj)) {
		const newKey = `${prefix}_${key}`;
		if (typeof value !== 'object' || value === null) {
			result[newKey] = value;
		} else if ('value' in value) {
			result[newKey] = (value as any).value;
		} else {
			flattenObject(value, result, newKey, prefixMode);
		}
	}
}

/**
 * Extract a flat element-table row using the detected source application.
 */
function toTitleCase(value: string): string {
	return value
		.split(/[\s_:-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join(' ');
}

function getRawAnalyticsCategory(obj: any): string {
	const rawValue = obj?.category
		?? obj?.Category
		?? obj?.properties?.category
		?? obj?.properties?.ifcType
		?? obj?.family
		?? obj?.properties?.family
		?? obj?.type
		?? obj?.properties?.type
		?? obj?.profile
		?? obj?.properties?.profile
		?? obj?.speckleType
		?? obj?.speckle_type
		?? 'Other';

	const rawText = String(rawValue).trim();
	if (!rawText) {
		return 'Other';
	}

	const cleaned = rawText
		.split('.')
		.pop()
		?.replace(/^OST_/, '')
		?.replace(/([a-z])([A-Z])/g, '$1 $2')
		?? rawText;

	return toTitleCase(cleaned);
}

export function normalizeElementCategory(obj: any, sourceApplication?: string): string {
	const haystack = [
		obj?.category,
		obj?.Category,
		obj?.properties?.category,
		obj?.properties?.ifcType,
		obj?.family,
		obj?.properties?.family,
		obj?.type,
		obj?.properties?.type,
		obj?.profile,
		obj?.properties?.profile,
		obj?.properties?.builtInCategory,
		obj?.speckleType,
		obj?.speckle_type,
		sourceApplication,
	].filter(Boolean).join(' ').toLowerCase();

	const rules: Array<{ label: string; pattern: RegExp }> = [
		{ label: 'Beams', pattern: /beam|girder|joist|purlin|brace|structural framing/ },
		{ label: 'Columns', pattern: /column|pillar|structural columns?/ },
		{ label: 'Floors', pattern: /floor|slab|deck|contourplate/ },
		{ label: 'Walls', pattern: /wall/ },
		{ label: 'Roofs', pattern: /roof/ },
		{ label: 'Foundations', pattern: /foundation|footing|pile/ },
		{ label: 'Doors', pattern: /door/ },
		{ label: 'Windows', pattern: /window|glazing/ },
		{ label: 'Stairs', pattern: /stair|staircase|ramp|step/ },
		{ label: 'Railings', pattern: /railing|handrail|guardrail/ },
		{ label: 'Pipes', pattern: /pipe|piping|plumbing/ },
		{ label: 'Ducts', pattern: /duct|hvac/ },
		{ label: 'Equipment', pattern: /equipment|fixture|furniture|casework/ },
		{ label: 'Spaces', pattern: /room|space|area/ },
		{ label: 'Rebar', pattern: /rebar|reinforcement/ },
	];

	for (const rule of rules) {
		if (rule.pattern.test(haystack)) {
			return rule.label;
		}
	}

	return getRawAnalyticsCategory(obj);
}

function getDisciplineLabel(category: string): string {
	if (['Beams', 'Columns', 'Floors', 'Foundations', 'Rebar'].includes(category)) {
		return 'Structure';
	}
	if (['Walls', 'Doors', 'Windows', 'Roofs', 'Stairs', 'Railings', 'Spaces', 'Equipment'].includes(category)) {
		return 'Architecture';
	}
	if (['Pipes', 'Ducts'].includes(category)) {
		return 'MEP';
	}
	return 'Other';
}

function toAnalyticsRows(counts: Map<string, number>, total: number): AnalyticsCountRow[] {
	return Array.from(counts.entries())
		.map(([label, count]) => ({
			label,
			count,
			percentage: total > 0 ? Number(((count / total) * 100).toFixed(2)) : 0,
		}))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function buildModelAnalytics(
	elements: any[],
	sourceApplication?: string,
	topCategories = 10,
	isPartialAnalysis = false,
	analyzedElementLimit?: number,
): ModelAnalyticsResult {
	const groupedCounts = new Map<string, number>();
	const rawCounts = new Map<string, number>();
	const disciplineCounts = new Map<string, number>();
	const totalElements = elements.length;

	for (const element of elements) {
		const groupedCategory = normalizeElementCategory(element, sourceApplication);
		const rawCategory = getRawAnalyticsCategory(element);
		const discipline = getDisciplineLabel(groupedCategory);

		groupedCounts.set(groupedCategory, (groupedCounts.get(groupedCategory) ?? 0) + 1);
		rawCounts.set(rawCategory, (rawCounts.get(rawCategory) ?? 0) + 1);
		disciplineCounts.set(discipline, (disciplineCounts.get(discipline) ?? 0) + 1);
	}

	const categories = toAnalyticsRows(groupedCounts, totalElements);
	const rawCategories = toAnalyticsRows(rawCounts, totalElements);
	const disciplines = toAnalyticsRows(disciplineCounts, totalElements);
	const chartRows = categories.slice(0, Math.max(1, topCategories));
	const palette = ['#2563eb', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316', '#ec4899', '#64748b'];
	const sourceApplicationId = detectSourceApplicationId(elements[0] ?? {}, sourceApplication);

	return {
		summary: {
			totalElements,
			groupedCategoryCount: categories.length,
			rawCategoryCount: rawCategories.length,
			sourceApplication: sourceApplication ?? 'Unknown',
			sourceApplicationId,
			topCategory: categories[0]?.label ?? null,
			isPartialAnalysis,
			analyzedElementLimit: analyzedElementLimit ?? null,
		},
		categories,
		rawCategories,
		disciplines,
		charts: {
			categoryBar: {
				type: 'bar',
				labels: chartRows.map((row) => row.label),
				datasets: [{
					label: 'Elements',
					data: chartRows.map((row) => row.count),
					backgroundColor: chartRows.map((_, index) => palette[index % palette.length]),
				}],
			},
			categoryPie: {
				type: 'pie',
				labels: chartRows.map((row) => row.label),
				datasets: [{
					label: 'Elements',
					data: chartRows.map((row) => row.count),
					backgroundColor: chartRows.map((_, index) => palette[index % palette.length]),
				}],
			},
			disciplineDoughnut: {
				type: 'doughnut',
				labels: disciplines.map((row) => row.label),
				datasets: [{
					label: 'Elements',
					data: disciplines.map((row) => row.count),
					backgroundColor: disciplines.map((_, index) => palette[index % palette.length]),
				}],
			},
		},
	};
}

export function extractElementRow(
	obj: any,
	options: ExtractElementRowOptions = {},
): Record<string, any> {
	const sourceApplication = options.sourceApplication ?? obj?.sourceApplication;
	const sourceApplicationId = detectSourceApplicationId(obj, sourceApplication);

	if (sourceApplicationId === 'tekla') {
		return {
			...extractTeklaRow(obj, options.includeUserProperties ?? true),
			sourceApplication: sourceApplication ?? 'Tekla',
			sourceApplicationId,
		};
	}

	if (sourceApplicationId === 'revit') {
		return {
			...extractRevitRow(
				obj,
				options.includeInstanceParams ?? true,
				options.includeTypeParams ?? false,
			),
			sourceApplication: sourceApplication ?? 'Revit',
			sourceApplicationId,
		};
	}

	return {
		...extractMetadataFromObject(obj, sourceApplication, false, true, 'none'),
		sourceApplicationId,
	};
}

/**
 * Extract a single Tekla element as a flat row — for use with the new Speckle connector
 * (Tekla 2023/2024/2025 connector from speckle-sharp-connectors).
 *
 * New connector produces objects with:
 *   speckle_type = "Objects.Data.TeklaObject"
 *   type         = Tekla API class name: "Beam", "ContourPlate", "RebarGroup", etc.
 *   name         = element mark
 *   properties   = {
 *     profile:   "IPE200"           (string, Part only)
 *     material:  "S235JR"           (string, Part only)
 *     grade:     "B500B"            (string, rebar/bolt only)
 *     size:      "12"               (string, rebar only)
 *     boltSize:  "24"               (string, bolt only)
 *     boltCount: "6"                (string, bolt only)
 *     boltStandard: "7990"          (string, bolt only)
 *     Report: {
 *       VOLUME:   { name, value, units }
 *       LENGTH:   { name, value, units }
 *       ...       (type-specific — see ReportPropertyExtractor in connector)
 *     }
 *     "User Defined Attributes": {
 *       MY_UDA:   value             (flat — all UDAs from GetAllUserProperties)
 *     }
 *   }
 *
 * Returns one object per element. JSON keys become n8n column headers automatically.
 * Pick one element type in the node to get a clean, consistent table every time.
 */
export function extractTeklaRow(obj: any, includeUserProperties: boolean): Record<string, any> {
	const speckleType = obj.speckle_type || obj.speckleType || '';
	// elementType comes from obj.type (Tekla C# class name: "Beam", "ContourPlate", "BoltArray", etc.)
	const elementType = obj.type || speckleType.split('.').pop() || 'Unknown';
	const props = obj.properties ?? {};

	const row: Record<string, any> = {
		id:            obj.id,
		applicationId: obj.applicationId ?? null,
		speckleType,
		elementType,
		name:          obj.name  ?? null,
		units:         obj.units ?? null,

		// Part properties (Beam, PolyBeam, SpiralBeam, ContourPlate)
		profile:          props.profile          ?? null,
		material:         props.material         ?? null,
		class:            props.class            ?? null,
		finish:           props.finish           ?? null,
		part_prefix:      props.part_prefix      ?? null,
		assembly_prefix:  props.assembly_prefix  ?? null,
		phase:            props.phase            ?? null,
		phase_name:       props.phase_name       ?? null,

		// RebarGroup (RebarGroup, CurvedRebarGroup, StraightRebarGroup), SingleRebar, RebarMesh
		grade:            props.grade            ?? null,
		size:             props.size             ?? null,
		start_hook_type:  props.start_hook_type  ?? null,  // RebarGroup only
		end_hook_type:    props.end_hook_type    ?? null,  // RebarGroup only

		// BoltGroup (BoltArray, BoltCircle, BoltXYList)
		boltSize:         props.boltSize         ?? null,
		boltStandard:     props.boltStandard     ?? null,
		boltType:         props.boltType         ?? null,
		patternType:      props.patternType      ?? null,  // "Array" | "Circle" | "XY"
		boltCount:        props.boltCount        ?? null,  // BoltCircle only

		// BooleanPart
		operative_profile:  props.operative_profile  ?? null,
		operative_material: props.operative_material ?? null,

		// Weld, PolygonWeld
		size_above: props.size_above ?? null,
		size_below: props.size_below ?? null,
	};

	if (includeUserProperties) {
		// Report values are boxed objects: {name, value, units?} → extract raw value
		const unboxReport = (v: any): any =>
			(typeof v === 'object' && v !== null && 'value' in v) ? v.value : v;

		// Report properties (type-specific quantities: VOLUME, LENGTH, WEIGHT, AREA, etc.)
		// Only produced for: Beam, ContourPlate, RebarGroup, SingleRebar, BoltArray
		const report: Record<string, any> = props.Report ?? {};
		for (const [key, value] of Object.entries(report)) {
			row[key] = unboxReport(value);
		}

		// User Defined Attributes — plain values (string | number), no unboxing needed
		const uda: Record<string, any> = props['User Defined Attributes'] ?? {};
		for (const [key, value] of Object.entries(uda)) {
			if (!(key in row)) row[key] = value;
		}
	}

	return row;
}

/**
 * Extract a single Revit element as a flat row — for use with the Speckle Revit connector
 * (Revit 2022–2026, speckle-sharp-connectors).
 *
 * The connector produces objects with:
 *   speckle_type = "Objects.Data.RevitObject"
 *   name         = "{category} - {element.Name}"
 *   type         = Family type name  (e.g. "Generic - 200mm")
 *   family       = Family name       (e.g. "Basic Wall")
 *   level        = Level name string (may be null)
 *   category     = Revit category    (e.g. "Walls", "Floors")
 *   units        = Speckle units     ("mm", "m", etc.)
 *   properties   = {
 *     elementId:        "1234"       (Revit integer ElementId as string)
 *     builtInCategory:  "OST_Walls"  (BuiltInCategory enum name)
 *     worksetId:        "1"          (optional)
 *     worksetName:      "Workset1"   (optional)
 *     roomApplicationId: "..."       (FamilyInstance only, optional)
 *     "Material Quantities": {
 *       "MaterialName (layerId)": { material, function, thickness, units }
 *     }
 *     "Parameters": {
 *       "Instance Parameters": {
 *         "GroupName": {
 *           "HumanName": { value, name, internalDefinitionName, units? }
 *         }
 *       }
 *       "Type Parameters": {
 *         "GroupName": {
 *           "HumanName": { value, name, internalDefinitionName, units? }
 *         }
 *       }
 *       "System Type Parameters": null | { ... }
 *     }
 *   }
 *
 * Instance parameters are flattened to top-level columns using the human-readable name as key.
 * Type parameters get a "type_" prefix. If two parameters share the same human-readable name
 * across different groups, the second occurrence is disambiguated as "GroupName_ParamName".
 */
export function extractRevitRow(
	obj: any,
	includeInstanceParams: boolean,
	includeTypeParams: boolean,
): Record<string, any> {
	const speckleType = obj.speckle_type || obj.speckleType || '';
	const props = obj.properties ?? {};

	const row: Record<string, any> = {
		id:             obj.id,
		applicationId:  obj.applicationId  ?? null,
		speckleType,
		name:           obj.name           ?? null,
		type:           obj.type           ?? null,
		family:         obj.family         ?? null,
		level:          obj.level          ?? null,
		category:       obj.category ?? obj.Category ?? null,
		units:          obj.units          ?? null,
		// Class properties set by ClassPropertiesExtractor
		elementId:        props.elementId        ?? null,
		builtInCategory:  props.builtInCategory  ?? null,
		worksetName:      props.worksetName       ?? null,
	};

	// Extract .value from a boxed parameter dict {value, name, internalDefinitionName, units?}
	const unboxParam = (p: any): any =>
		(typeof p === 'object' && p !== null && 'value' in p) ? p.value : p;

	// Sanitize a string into a safe column key (collapse whitespace/punctuation to _)
	const sanitize = (s: string): string =>
		String(s).replace(/[\s/\\()[\]&+\-#*:?!@%^={}<>|,;'"]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

	// Flatten one parameter set (Instance or Type) into the row.
	// groups = { "GroupName": { "ParamName": {value, name, internalDefinitionName, units?} } }
	// prefix = "" for instance params, "type_" for type params.
	const flattenParamGroups = (
		groups: Record<string, any> | null | undefined,
		prefix: string,
	): void => {
		if (!groups || typeof groups !== 'object') return;
		for (const [groupName, groupParams] of Object.entries(groups)) {
			if (!groupParams || typeof groupParams !== 'object') continue;
			for (const [paramName, paramData] of Object.entries(groupParams as Record<string, any>)) {
				const baseKey = prefix + sanitize(paramName);
				// If the simple key already exists, disambiguate with the group name
				const key = baseKey in row
					? prefix + sanitize(groupName) + '_' + sanitize(paramName)
					: baseKey;
				row[key] = unboxParam(paramData);
			}
		}
	};

	const params = props.Parameters ?? {};
	const hasV3Params = params['Instance Parameters'] !== undefined || params['Type Parameters'] !== undefined;

	if (includeInstanceParams) {
		if (hasV3Params) {
			// v3 connector: grouped under properties.Parameters['Instance Parameters']
			flattenParamGroups(params['Instance Parameters'], '');
		} else if (obj.parameters && typeof obj.parameters === 'object') {
			// v2 connector: flat dict at obj.parameters keyed by internal name
			// No instance/type separation exists in v2 — all are treated as instance params
			for (const [key, paramData] of Object.entries(obj.parameters as Record<string, any>)) {
				const k = sanitize(String(key));
				if (!(k in row)) row[k] = unboxParam(paramData);
			}
		}
	}
	if (includeTypeParams) {
		// v3 connector: grouped under properties.Parameters['Type Parameters']
		// v2 connector: no type/instance separation — nothing additional to add
		flattenParamGroups(params['Type Parameters'], 'type_');
	}

	return row;
}

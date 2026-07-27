
/**
 * Flattens various Speckle property structures (Revit, IFC, Tekla) into a clean parameter object.
 * @param data The raw object data
 * @returns A flattened object containing processed properties and parameters
 */
export function flattenProperties(data: any): any {
    // New DataObject-schema connectors (Revit, Tekla, ...) put family/type/ifcType/profile as
    // top-level siblings of speckleType; older connectors nested them under `properties`.
    // Check top-level first, then fall back to the nested location.
    const family = data.family ?? data.properties?.family;
    const type = data.type ?? data.properties?.type;
    const ifcType = data.ifcType ?? data.properties?.ifcType;
    const profile = data.profile ?? data.properties?.profile; // Tekla profile

    // Build element type key (IFC > Revit > Profile > Speckle type)
    const elementType =
        ifcType ||
        (family && type ? `${family}:${type}` : null) ||
        profile ||
        data.speckleType ||
        data.speckle_type ||
        'Unknown';

    // Flatten Report attributes (Tekla specific)
    const reportProps: Record<string, any> = {};
    if (data.properties?.Report) {
        for (const key in data.properties.Report) {
            const val = data.properties.Report[key];
            if (val && typeof val === 'object' && 'value' in val) {
                reportProps[key] = val.value;
            } else {
                reportProps[key] = val;
            }
        }
    }

    // Flatten Revit Parameters (Instance & Type)
    // New (v3) connector groups these under properties.Parameters['Instance Parameters'/'Type Parameters'];
    // older (v2) connector nests them directly under properties.
    const revitProps: Record<string, any> = {};
    const v3RevitParams = data.properties?.Parameters;
    const instanceParams = v3RevitParams?.['Instance Parameters'] ?? data.properties?.['Instance Parameters'];
    const typeParams = v3RevitParams?.['Type Parameters'] ?? data.properties?.['Type Parameters'];
    const assignUnboxed = (target: Record<string, any>, group: Record<string, any>) => {
        for (const [key, value] of Object.entries(group)) {
            target[key] = (value && typeof value === 'object' && 'value' in value) ? (value as any).value : value;
        }
    };
    if (instanceParams) assignUnboxed(revitProps, instanceParams);
    if (typeParams) assignUnboxed(revitProps, typeParams);

    // Flatten IFC Property Sets — either an intermediate `properties['Property Sets']` wrapper
    // (older connector), or property sets nested directly under `properties` (newer connector,
    // e.g. properties.Pset_WallCommon.FireRating).
    const ifcProps: Record<string, any> = {};
    const reservedPropKeys = new Set(['ifcType', 'tag', 'family', 'type', 'profile', 'material', 'Report', 'Instance Parameters', 'Type Parameters', 'Parameters', 'Property Sets', 'parameters', 'userDefinedAttributes', 'User Defined Attributes']);
    if (data.properties?.['Property Sets']) {
        for (const psetKey in data.properties['Property Sets']) {
            const pset = data.properties['Property Sets'][psetKey];
            if (pset && typeof pset === 'object') {
                Object.assign(ifcProps, pset);
            }
        }
    } else if (data.properties) {
        for (const [key, value] of Object.entries(data.properties)) {
            if (!reservedPropKeys.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
                Object.assign(ifcProps, value as Record<string, any>);
            }
        }
    }

    // Flatten parameters
    const parameters = {
        ...data.parameters,
        ...data.properties?.parameters,
        ...(data.properties?.userDefinedAttributes ?? data.properties?.['User Defined Attributes']), // Tekla UDAs
        ...reportProps,
        ...revitProps, // Revit Parameters
        ...ifcProps,   // IFC Properties
    };

    return {
        id: data.id,
        speckleType: data.speckleType || data.speckle_type,
        elementType: elementType,
        category: data.category,
        family,
        type,
        ifcType,
        profile,
        material: data.material ?? data.properties?.material,
        level: data.level?.name || data.level, // Extract level name if object
        ...parameters // Spread all parameters to top level
    };
}

/**
 * Traverses a Speckle object and returns a map of identifiable children.
 * Key: applicationId (preferred) or id
 * Value: The object data
 */
export async function flattenObjectTree(
    rootObject: any,
    fetchObject: (id: string) => Promise<any>
): Promise<Map<string, any>> {
    const objectMap = new Map<string, any>();
    const visited = new Set<string>();

    // Dedupes fetches for a referencedId seen more than once (common — the same shared
    // sub-object, e.g. a level or material, is often referenced from many parents).
    // Final traversal result is unaffected: the visited-by-id check below already made a
    // second visit a no-op, so this just avoids re-fetching data whose result would be thrown away.
    const fetchedRefs = new Set<string>();

    // Resolves up to REF_BATCH_SIZE sibling reference stubs concurrently instead of one at
    // a time — the dominant slowness for models where a single array (e.g. 'elements')
    // holds hundreds of {referencedId} entries. Non-reference values pass through
    // untouched; the caller still traverses the returned array in original order.
    const REF_BATCH_SIZE = 12;
    const resolveSiblingBatch = async (items: any[]): Promise<any[]> => {
        const resolved: any[] = new Array(items.length);
        const pending: { index: number; refId: string }[] = [];

        items.forEach((item, index) => {
            if (item && typeof item === 'object' && item.speckle_type === 'reference' && item.referencedId) {
                if (fetchedRefs.has(item.referencedId)) {
                    resolved[index] = null; // already resolved via another path
                } else {
                    fetchedRefs.add(item.referencedId);
                    pending.push({ index, refId: item.referencedId });
                }
            } else {
                resolved[index] = item;
            }
        });

        if (pending.length > 0) {
            const fetched = await Promise.all(pending.map(async ({ refId }) => {
                try {
                    return await fetchObject(refId);
                } catch (e) {
                    return null; // Ignore missing references
                }
            }));
            pending.forEach(({ index }, i) => { resolved[index] = fetched[i]; });
        }

        return resolved;
    };

    async function traverse(obj: any) {
        if (!obj || typeof obj !== 'object') return;

        // Use ID for loop detection
        if (obj.id) {
            if (visited.has(obj.id)) return;
            visited.add(obj.id);
        }

        // Identify if this is a trackable object (has speckle_type and id)
        // We prioritize applicationId for stable identity across versions
        const key = obj.applicationId || obj.id;

        if (obj.id && key) {
            objectMap.set(key, obj);
        }

        // Traverse all properties to find children/references
        for (const k in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
            const val = obj[k];
            if (!val || typeof val !== 'object') continue;

            if (Array.isArray(val)) {
                for (let start = 0; start < val.length; start += REF_BATCH_SIZE) {
                    const batch = val.slice(start, start + REF_BATCH_SIZE);
                    const resolvedBatch = await resolveSiblingBatch(batch);
                    for (const resolved of resolvedBatch) {
                        await traverse(resolved);
                    }
                }
            } else if (val.speckle_type === 'reference' && val.referencedId) {
                const [resolved] = await resolveSiblingBatch([val]);
                await traverse(resolved);
            } else {
                await traverse(val);
            }
        }
    }

    await traverse(rootObject);
    return objectMap;
}

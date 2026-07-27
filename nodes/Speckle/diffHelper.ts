import { SpeckleClient } from './api/client';

export interface DiffResult {
    added: string[];
    removed: string[];
    modified: string[];
    unchanged: string[];
    summary: {
        addedCount: number;
        removedCount: number;
        modifiedCount: number;
        unchangedCount: number;
    };
    changes?: Record<string, ChangeSet>;
}

export interface ChangeSet {
    [key: string]: {
        old: any;
        new: any;
    };
}

/**
 * Flattens an object for diffing, excluding system keys
 */
function flattenForDiff(obj: any, prefix = '', result: Record<string, any> = {}): Record<string, any> {
    if (!obj || typeof obj !== 'object') {
        result[prefix] = obj;
        return result;
    }

    // Exclude specific system keys from diff
    const excludeKeys = new Set(['id', 'totalChildrenCount', 'createdAt', 'updatedAt', '__closure', 'displayValue', 'renderMaterial', 'displayMesh']);

    for (const key in obj) {
        if (excludeKeys.has(key)) continue;
        
        const val = obj[key];
        const newKey = prefix ? `${prefix}.${key}` : key;

        if (Array.isArray(val)) {
            // For arrays of primitives, treat as single value
            if (val.length > 0 && typeof val[0] !== 'object') {
                result[newKey] = JSON.stringify(val);
            } else if (val.length === 0) {
                 result[newKey] = '[]';
            } else {
                // Array of objects - simpler to just JSON stringify for now to detect *that* it changed
                // or recurse if needed. Let's Recurse by index for cleaner diff? 
                // A massive array will spam the changelog.
                // Let's just store the length/summary for now if it's huge?
                result[newKey] = `[Array(${val.length})]`; 
            }
        } else if (val && typeof val === 'object') {
            if (val.speckle_type === 'reference') {
                result[newKey] = `REF:${val.referencedId}`;
            } else {
                flattenForDiff(val, newKey, result);
            }
        } else {
            result[newKey] = val;
        }
    }
    return result;
}

/**
 * Paginated diff comparison that processes objects in chunks
 * Optimized for large models to reduce memory usage
 * 
 * @param client SpeckleClient instance
 * @param projectId Project/Stream ID
 * @param refObjA Referenced object ID for version A
 * @param refObjB Referenced object ID for version B
 * @param pageSize Number of objects to process per page (default: 500)
 */
export async function diffObjectsPaginated(
    client: SpeckleClient,
    projectId: string,
    refObjA: string,
    refObjB: string,
    pageSize: number = 500,
    detailed: boolean = false
): Promise<DiffResult> {
    
    // Maps to track objects by applicationId (stable identifier)
    const mapA = new Map<string, { id: string, applicationId: string }>();
    const mapB = new Map<string, { id: string, applicationId: string }>();

    // Fetch version A in pages
    let cursorA: string | null = null;
    do {
        const result = await client.getObjectMetadata(projectId, refObjA, pageSize, cursorA);
        
        for (const obj of result.objects) {
            const key = obj.applicationId || obj.id;
            if (key && obj.id) {
                mapA.set(key, { id: obj.id, applicationId: obj.applicationId });
            }
        }
        
        cursorA = result.cursor;
    } while (cursorA);

    // Fetch version B in pages
    let cursorB: string | null = null;
    do {
        const result = await client.getObjectMetadata(projectId, refObjB, pageSize, cursorB);
        
        for (const obj of result.objects) {
            const key = obj.applicationId || obj.id;
            if (key && obj.id) {
                mapB.set(key, { id: obj.id, applicationId: obj.applicationId });
            }
        }
        
        cursorB = result.cursor;
    } while (cursorB);

    // Perform comparison
    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];
    
    // Track modified pairs for detailed diff
    const modifiedPairs: { oldId: string, newId: string, applicationId: string }[] = [];

    // Compare B against A (Added, Modified, Unchanged)
    for (const [key, objB] of mapB.entries()) {
        if (!mapA.has(key)) {
            // Present in B, not in A -> Added
            added.push(objB.id);
        } else {
            // Present in both -> Check for modification
            const objA = mapA.get(key)!;
            
            // If the content hash (id) changed, it's modified
            if (objA.id !== objB.id) {
                modified.push(objB.id);
                if (detailed) {
                    modifiedPairs.push({ 
                        oldId: objA.id, 
                        newId: objB.id,
                        applicationId: key 
                    });
                }
            } else {
                unchanged.push(objB.id);
            }
        }
    }

    // Scan A for Removed (Present in A, not in B)
    for (const [key, objA] of mapA.entries()) {
        if (!mapB.has(key)) {
            removed.push(objA.id);
        }
    }

    // Compute detailed changes if requested
    const changes: Record<string, ChangeSet> = {};
    
    if (detailed && modifiedPairs.length > 0) {
        console.log(`[Diff] Starting detailed comparison for ${modifiedPairs.length} objects...`);
        
        // Process in chunks to avoid overwhelming the server
        const chunk = 10;
        for (let i = 0; i < modifiedPairs.length; i += chunk) {
            const batch = modifiedPairs.slice(i, i + chunk);
            
            await Promise.all(batch.map(async (pair) => {
                try {
                    // Fetch full objects
                    const [oldObj, newObj] = await Promise.all([
                        client.fetchObject(projectId, pair.oldId),
                        client.fetchObject(projectId, pair.newId)
                    ]);
                    
                    // Flatten properties for easier comparison
                    const flatOld = flattenForDiff(oldObj);
                    const flatNew = flattenForDiff(newObj);
                    
                    // Compare
                    const changeset: ChangeSet = {};
                    const allKeys = new Set([...Object.keys(flatOld), ...Object.keys(flatNew)]);
                    
                    // debug logs
                    console.log(`[Diff] Comparing ${pair.applicationId} (${pair.oldId} -> ${pair.newId}). Keys: ${allKeys.size}`);

                    let hasChanges = false;
                    for (const key of allKeys) {
                        // Keys already filtered in flattenForDiff
                        
                        const valOld = flatOld[key];
                        const valNew = flatNew[key];
                        
                        // Simple equality check
                        if (JSON.stringify(valOld) !== JSON.stringify(valNew)) {
                            changeset[key] = {
                                old: valOld,
                                new: valNew
                            };
                            hasChanges = true;
                        }
                    }
                    
                    if (hasChanges) {
                        changes[pair.newId] = changeset;
                    }
                } catch (err) {
                    console.error(`[Diff] Failed to compare object pair ${pair.oldId} -> ${pair.newId}`, err);
                }
            }));
        }
    } else {
        if (detailed && modifiedPairs.length === 0) {
            console.log(`[Diff] No modified pairs found to compare.`);
        }
    }

    return {
        added,
        removed,
        modified,
        unchanged,
        summary: {
            addedCount: added.length,
            removedCount: removed.length,
            modifiedCount: modified.length,
            unchangedCount: unchanged.length
        },
        changes: detailed ? changes : undefined
    };
}

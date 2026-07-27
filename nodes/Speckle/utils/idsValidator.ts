import { parseStringPromise } from 'xml2js';

export interface IdsValidationReport {
    passed: boolean;
    summary: {
        totalObjects: number;
        checkedObjects: number;
        passedObjects: number;
        failedObjects: number;
    };
    results: IdsCheckResult[];
}

export interface IdsCheckResult {
    objectId: string;
    speckleType: string;
    status: 'PASS' | 'FAIL' | 'WARNING' | 'SKIPPED';
    failedRequirements: string[];
}

export async function validateObjectsAgainstIds(objects: any[], idsXml: string): Promise<IdsValidationReport> {
    const report: IdsValidationReport = {
        passed: true,
        summary: {
            totalObjects: objects.length,
            checkedObjects: 0,
            passedObjects: 0,
            failedObjects: 0,
        },
        results: [],
    };

    try {
        const parsedIds = await parseStringPromise(idsXml, { explicitArray: false, mergeAttrs: true });

        // Handle different IDS versions/structures conservatively
        const specifications = parsedIds['ids:ids']?.['ids:specification'] || parsedIds.ids?.specification;
        const specsArray = Array.isArray(specifications) ? specifications : (specifications ? [specifications] : []);

        if (specsArray.length === 0) {
            console.warn('No specifications found in IDS file');
            return report; // Return empty report if no specs
        }

        for (const obj of objects) {
            let isApplicableToAny = false;
            let objPassed = true;
            const failedReqs: string[] = [];

            for (const spec of specsArray) {
                const applicability = spec['ids:applicability'] || spec.applicability;
                const requirements = spec['ids:requirements'] || spec.requirements;

                // Extract spec name from multiple possible locations
                const specName = spec['name'] || spec['ids:name'] || spec['@_name'] || 'Unknown Spec';

                if (checkApplicability(obj, applicability)) {
                    isApplicableToAny = true;
                    const reqErrors = checkRequirements(obj, requirements, specName);
                    if (reqErrors.length > 0) {
                        objPassed = false;
                        failedReqs.push(...reqErrors);
                    }
                }
            }

            if (isApplicableToAny) {
                report.summary.checkedObjects++;
                if (objPassed) {
                    report.summary.passedObjects++;
                    report.results.push({
                        objectId: obj.id,
                        speckleType: obj.speckleType || obj.speckle_type,
                        status: 'PASS',
                        failedRequirements: [],
                    });
                } else {
                    report.summary.failedObjects++;
                    report.passed = false;
                    report.results.push({
                        objectId: obj.id,
                        speckleType: obj.speckleType || obj.speckle_type,
                        status: 'FAIL',
                        failedRequirements: failedReqs,
                    });
                }
            }
        }

    } catch (error) {
        console.error('IDS Validation Error:', error);
        throw new Error('Failed to parse or validate IDS file: ' + (error instanceof Error ? error.message : String(error)));
    }

    return report;
}

function checkApplicability(obj: any, applicability: any): boolean {
    if (!applicability) return true;

    // Check 'ids:entity' or 'entity'
    const entity = applicability['ids:entity'] || applicability.entity;
    if (entity) {
        const requiredName = entity.name?.['ids:simpleValue'] || entity.name?.simpleValue || entity.name;

        // Check both camelCase and snake_case versions of properties
        const objType = obj.speckleType || obj.speckle_type || '';
        const ifcType = obj.ifcType || obj.ifc_type || obj.properties?.ifcType || obj.properties?.ifc_type || '';
        const category = obj.category || '';

        // Loose matching for IFC types, speckle types, and categories
        if (requiredName) {
            const reqLower = requiredName.toLowerCase();
            const typeMatch = objType.toLowerCase().includes(reqLower);
            const ifcMatch = ifcType.toLowerCase().includes(reqLower);
            const catMatch = category.toLowerCase().includes(reqLower);

            if (!typeMatch && !ifcMatch && !catMatch) {
                return false;
            }
        }
    }

    return true;
}

function checkRequirements(obj: any, requirements: any, specName: string): string[] {
    const errors: string[] = [];
    if (!requirements) return errors;

    const props = requirements['ids:property'] || requirements.property;
    const propArray = Array.isArray(props) ? props : (props ? [props] : []);

    for (const propRequirement of propArray) {
        // Extract property set name from multiple possible locations
        const pset = propRequirement['ids:propertySet']?.['ids:simpleValue']
            || propRequirement['ids:propertySet']?.['_']
            || propRequirement.propertySet?.simpleValue
            || propRequirement.propertySet
            || 'Unknown';

        // Extract property name from multiple possible locations
        const name = propRequirement['ids:baseName']?.['ids:simpleValue']
            || propRequirement['ids:baseName']?.['_']
            || propRequirement['ids:name']?.['ids:simpleValue']
            || propRequirement['ids:name']?.['_']
            || propRequirement.baseName?.simpleValue
            || propRequirement.baseName
            || propRequirement.name?.simpleValue
            || propRequirement.name;

        if (!name) {
            errors.push(`[Spec: ${specName}] Property requirement missing name (Pset: ${pset})`);
            continue;
        }

        const val = findValue(obj, name, pset);

        if (val === undefined || val === null) {
            errors.push(`[Spec: ${specName}] Missing required property: ${name} (Pset: ${pset})`);
            continue;
        }

        const expectedValue = propRequirement['ids:value']?.['ids:simpleValue']
            || propRequirement['ids:value']?.['_']
            || propRequirement.value?.simpleValue
            || propRequirement.value;
        if (expectedValue && String(val) !== String(expectedValue)) {
            errors.push(`[Spec: ${specName}] Property ${name} value mismatch. Expected '${expectedValue}', got '${val}' (Pset: ${pset})`);
        }
    }

    return errors;
}

function findValue(obj: any, propName: string, pset?: string): any {
    if (!propName) return undefined;

    // 1. Check top-level property (might be spread from parameters)
    if (obj[propName] !== undefined) return obj[propName];

    // 2. Check obj.properties
    if (obj.properties) {
        if (obj.properties[propName] !== undefined) return obj.properties[propName];

        // Check in property sets if pset is provided
        if (pset && obj.properties[pset] && obj.properties[pset][propName] !== undefined) {
            return obj.properties[pset][propName];
        }

        // Check IFC Property Sets
        if (obj.properties['Property Sets']) {
            const propertySets = obj.properties['Property Sets'];
            // Check specific pset if provided
            if (pset && propertySets[pset] && propertySets[pset][propName] !== undefined) {
                return propertySets[pset][propName];
            }
            // Search all property sets
            for (const setKey in propertySets) {
                if (propertySets[setKey][propName] !== undefined) {
                    return propertySets[setKey][propName];
                }
            }
        }

        // Check Revit Instance/Type Parameters — v2 connector nests these directly under
        // properties; v3 connector groups them one level deeper under properties.Parameters.
        const instanceParams = obj.properties['Instance Parameters'] ?? obj.properties.Parameters?.['Instance Parameters'];
        if (instanceParams && instanceParams[propName] !== undefined) {
            const v = instanceParams[propName];
            return (v && typeof v === 'object' && 'value' in v) ? v.value : v;
        }

        const typeParams = obj.properties['Type Parameters'] ?? obj.properties.Parameters?.['Type Parameters'];
        if (typeParams && typeParams[propName] !== undefined) {
            const v = typeParams[propName];
            return (v && typeof v === 'object' && 'value' in v) ? v.value : v;
        }

        // Check Tekla Report properties (boxed as {name, value, units?})
        if (obj.properties.Report && obj.properties.Report[propName] !== undefined) {
            const v = obj.properties.Report[propName];
            return (v && typeof v === 'object' && 'value' in v) ? v.value : v;
        }

        // Check Tekla User Defined Attributes
        const uda = obj.properties['User Defined Attributes'] ?? obj.properties.userDefinedAttributes;
        if (uda && uda[propName] !== undefined) {
            return uda[propName];
        }
    }

    // 3. Check obj.parameters (should include flattened parameters from metadata)
    if (obj.parameters && obj.parameters[propName] !== undefined) {
        return obj.parameters[propName];
    }

    return undefined;
}

import { Speckle } from '../../../nodes/Speckle/Speckle.node';

describe('Speckle Node', () => {
    let speckle: Speckle;

    beforeEach(() => {
        speckle = new Speckle();
    });

    describe('Node Description', () => {
        it('should have correct basic properties', () => {
            expect(speckle.description.displayName).toBe('Speckle');
            expect(speckle.description.name).toBe('speckle');
            expect(speckle.description.version).toBe(1);
            expect(speckle.description.description).toContain('Speckle');
        });

        it('should have correct inputs and outputs', () => {
            expect(speckle.description.inputs).toEqual(['main']);
            expect(speckle.description.outputs).toEqual(['main']);
        });

        it('should require credentials', () => {
            const credentials = speckle.description.credentials;
            expect(credentials).toBeDefined();
            expect(credentials).toHaveLength(1);
            expect(credentials![0].name).toBe('speckleApi');
            expect(credentials![0].required).toBe(true);
        });
    });

    describe('Resource Options', () => {
        it('should have all resources defined', () => {
            const resourceField = speckle.description.properties.find(
                (p: any) => p.name === 'resource'
            );
            expect(resourceField).toBeDefined();
            const resources = (resourceField as any).options.map((o: any) => o.value);

            expect(resources).toContain('project');
            expect(resources).toContain('model');
            expect(resources).toContain('version');
            expect(resources).toContain('object');
            expect(resources).toContain('user');
            expect(resources).toContain('server');
            expect(resources).toContain('comment');
        });
    });

    describe('Project Operations', () => {
        it('should have all CRUD operations for projects', () => {
            const projectOps = speckle.description.properties.find(
                (p: any) => p.name === 'operation' && p.displayOptions?.show?.resource?.[0] === 'project'
            );
            expect(projectOps).toBeDefined();

            const operations = (projectOps as any).options.map((o: any) => o.value);

            // Write operations
            expect(operations).toContain('create');
            expect(operations).toContain('update');
            expect(operations).toContain('delete');

            // Read operations
            expect(operations).toContain('get');
            expect(operations).toContain('getAll');
            expect(operations).toContain('search');
            expect(operations).toContain('transfer');
            expect(operations).toContain('exportPayload');
            expect(operations).toContain('importPayload');
        });

        it('should have required input fields for project create', () => {
            const projectNameField = speckle.description.properties.find(
                (p: any) => p.name === 'projectName'
            );
            expect(projectNameField).toBeDefined();
            expect((projectNameField as any).required).toBe(true);
            expect((projectNameField as any).displayOptions.show.operation).toContain('create');
        });
    });

    describe('Model Operations', () => {
        it('should have create and update operations for models', () => {
            const modelOps = speckle.description.properties.find(
                (p: any) => p.name === 'operation' && p.displayOptions?.show?.resource?.[0] === 'model'
            );
            expect(modelOps).toBeDefined();

            const operations = (modelOps as any).options.map((o: any) => o.value);
            expect(operations).toContain('create');
            expect(operations).toContain('update');
            expect(operations).toContain('getAll');
            expect(operations).toContain('transfer');
            expect(operations).toContain('exportPayload');
            expect(operations).toContain('importPayload');
        });
    });

    describe('Version Operations', () => {
        it('should have create operation for versions', () => {
            const versionOps = speckle.description.properties.find(
                (p: any) => p.name === 'operation' && p.displayOptions?.show?.resource?.[0] === 'version'
            );
            expect(versionOps).toBeDefined();

            const operations = (versionOps as any).options.map((o: any) => o.value);
            expect(operations).toContain('create');
            expect(operations).toContain('getAll');
            expect(operations).toContain('transfer');
            expect(operations).toContain('exportPayload');
            expect(operations).toContain('importPayload');
        });
    });

    describe('Comment Operations', () => {
        it('should have all comment operations', () => {
            const commentOps = speckle.description.properties.find(
                (p: any) => p.name === 'operation' && p.displayOptions?.show?.resource?.[0] === 'comment'
            );
            expect(commentOps).toBeDefined();

            const operations = (commentOps as any).options.map((o: any) => o.value);
            expect(operations).toContain('create');
            expect(operations).toContain('reply');
            expect(operations).toContain('archive');
            expect(operations).toContain('getProjectComments');
        });
    });

    describe('Object Operations', () => {
        it('should expose the IFC element table action and the specific Revit/Tekla element table operations', () => {
            const objectOps = speckle.description.properties.find(
                (p: any) => p.name === 'operation' && p.displayOptions?.show?.resource?.[0] === 'object'
            );
            expect(objectOps).toBeDefined();

            const operations = (objectOps as any).options.map((o: any) => o.value);
            expect(operations).toContain('extractElementTable');
            expect(operations).toContain('extractTeklaTable');
            expect(operations).toContain('extractRevitTable');
            expect(operations).toContain('analyzeModel');
            expect(operations).toContain('validateProperties');
        });
    });

    describe('Update Properties UI', () => {
        it('should offer a dropdown of object property paths for updateProperties', () => {
            const updatePropertiesField = speckle.description.properties.find(
                (p: any) => p.name === 'propertiesToUpdate'
            );
            expect(updatePropertiesField).toBeDefined();

            const propertyValues = (updatePropertiesField as any).options[0].values;
            const propertyPathField = propertyValues.find((p: any) => p.name === 'propertyPath');
            expect(propertyPathField).toBeDefined();
            expect(propertyPathField.type).toBe('options');
            expect(propertyPathField.typeOptions.loadOptionsMethod).toBe('getObjectPropertyPaths');

            const valueTypeField = propertyValues.find((p: any) => p.name === 'valueType');
            expect(valueTypeField).toBeDefined();
            expect(valueTypeField.type).toBe('options');
            expect(valueTypeField.options.map((o: any) => o.value)).toEqual(
                expect.arrayContaining(['auto', 'string', 'integer', 'double', 'boolean', 'date'])
            );
        });

        it('should offer validation rules with selectable property checks', () => {
            const validationRulesField = speckle.description.properties.find(
                (p: any) => p.name === 'validationRules'
            );
            expect(validationRulesField).toBeDefined();

            const ruleValues = (validationRulesField as any).options[0].values;
            const propertyPathField = ruleValues.find((p: any) => p.name === 'propertyPath');
            const checkTypeField = ruleValues.find((p: any) => p.name === 'checkType');

            expect(propertyPathField).toBeDefined();
            expect(propertyPathField.type).toBe('options');
            expect(propertyPathField.typeOptions.loadOptionsMethod).toBe('getObjectPropertyPaths');

            expect(checkTypeField).toBeDefined();
            expect(checkTypeField.type).toBe('options');
            expect(checkTypeField.options.map((o: any) => o.value)).toEqual(
                expect.arrayContaining(['equals', 'greaterThan', 'lessThan', 'hasValue', 'isTrue', 'isFalse'])
            );
        });
    });

    describe('Debug Logging', () => {
        it('should have enable debug logging option', () => {
            const debugField = speckle.description.properties.find(
                (p: any) => p.name === 'enableDebug'
            );
            expect(debugField).toBeDefined();
            expect((debugField as any).type).toBe('boolean');
            expect((debugField as any).default).toBe(false);
        });
    });
});

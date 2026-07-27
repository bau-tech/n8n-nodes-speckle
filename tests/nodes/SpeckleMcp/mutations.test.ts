import { mutations } from '../../../nodes/Speckle/graphql/mutations';

describe('GraphQL Mutations', () => {
    describe('Project Mutations', () => {
        it('should have projectCreate mutation', () => {
            expect(mutations.projectCreate).toBeDefined();
            expect(mutations.projectCreate).toContain('projectMutations');
            expect(mutations.projectCreate).toContain('create(input: $input)');
            expect(mutations.projectCreate).toContain('$input: ProjectCreateInput!');
        });

        it('should have projectUpdate mutation', () => {
            expect(mutations.projectUpdate).toBeDefined();
            expect(mutations.projectUpdate).toContain('projectMutations');
            expect(mutations.projectUpdate).toContain('update(update: $update)');
            expect(mutations.projectUpdate).toContain('$update: ProjectUpdateInput!');
        });

        it('should have projectDelete mutation', () => {
            expect(mutations.projectDelete).toBeDefined();
            expect(mutations.projectDelete).toContain('projectMutations');
            expect(mutations.projectDelete).toContain('delete(id: $projectId)');
        });
    });

    describe('Model Mutations', () => {
        it('should have modelCreate mutation', () => {
            expect(mutations.modelCreate).toBeDefined();
            expect(mutations.modelCreate).toContain('modelMutations');
            expect(mutations.modelCreate).toContain('$projectId: ID!');
            expect(mutations.modelCreate).toContain('$name: String!');
        });

        it('should have modelUpdate mutation', () => {
            expect(mutations.modelUpdate).toBeDefined();
            expect(mutations.modelUpdate).toContain('modelMutations');
            expect(mutations.modelUpdate).toContain('update(input:');
        });
    });

    describe('Version Mutations', () => {
        it('should have versionCreate mutation', () => {
            expect(mutations.versionCreate).toBeDefined();
            expect(mutations.versionCreate).toContain('versionMutations');
            expect(mutations.versionCreate).toContain('$projectId: String!');
            expect(mutations.versionCreate).toContain('$modelId: String!');
            expect(mutations.versionCreate).toContain('$objectId: String!');
            expect(mutations.versionCreate).toContain('$message: String');
        });
    });

    describe('Comment Mutations', () => {
        it('should have commentCreate mutation', () => {
            expect(mutations.commentCreate).toBeDefined();
            expect(mutations.commentCreate).toContain('commentMutations');
            expect(mutations.commentCreate).toContain('$projectId: String!');
            expect(mutations.commentCreate).toContain('$content: JSONObject!');
            expect(mutations.commentCreate).toContain('$resourceIdString: String!');
        });

        it('should have commentArchive mutation', () => {
            expect(mutations.commentArchive).toBeDefined();
            expect(mutations.commentArchive).toContain('commentMutations');
            expect(mutations.commentArchive).toContain('archive(input:');
            expect(mutations.commentArchive).toContain('$archived: Boolean!');
        });
    });

    describe('Mutation Structure', () => {
        it('should return all expected mutations', () => {
            expect(Object.keys(mutations)).toEqual(
                expect.arrayContaining([
                    'projectCreate',
                    'projectUpdate',
                    'projectDelete',
                    'modelCreate',
                    'modelUpdate',
                    'versionCreate',
                    'commentCreate',
                    'commentArchive',
                ])
            );
        });

        it('should have properly formatted GraphQL syntax', () => {
            Object.values(mutations).forEach((mutation) => {
                expect(mutation).toContain('mutation');
                expect(mutation.trim().startsWith('mutation')).toBe(true);
            });
        });
    });
});

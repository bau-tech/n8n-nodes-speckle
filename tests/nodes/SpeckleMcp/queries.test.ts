import { queries } from '../../../nodes/Speckle/graphql/queries';

describe('Speckle GraphQL Queries', () => {
	it('should request root comment fields for project comment threads', () => {
		expect(queries.projectComments).toContain('commentThreads(limit: $limit)');
		expect(queries.projectComments).toContain('items {');
		expect(queries.projectComments).toContain('text {');
		expect(queries.projectComments).toContain('rawText');
		expect(queries.projectComments).toContain('replies {');
	});
});
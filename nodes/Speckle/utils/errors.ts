import { NodeOperationError } from 'n8n-workflow';

export class SpeckleError extends NodeOperationError {
  constructor(node: any, message: string, errorData?: any) {
    super(node, message, { description: errorData ? JSON.stringify(errorData) : undefined });
  }
}

export const handleGraphQLError = (node: any, error: any): never => {
  if (error.response?.data?.errors) {
    throw new SpeckleError(
      node,
      'GraphQL Error',
      error.response.data.errors
    );
  }
  throw new SpeckleError(node, `API request failed: ${error.message}`);
};
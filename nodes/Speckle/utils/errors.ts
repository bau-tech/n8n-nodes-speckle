import { NodeOperationError } from 'n8n-workflow';

export class SpeckleError extends NodeOperationError {
  constructor(node: any, message: string, errorData?: any) {
    super(node, message, { description: errorData ? JSON.stringify(errorData) : undefined });
  }
}

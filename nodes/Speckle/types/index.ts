export interface SpeckleCredentials {
  serverUrl: string;
  token: string;
}

export interface GraphQLResponse {
  data?: any;
  errors?: Array<{
    message: string;
    locations?: Array<{
      line: number;
      column: number;
    }>;
    path?: string[];
  }>;
}

export type Resource = 'project' | 'model' | 'version' | 'object' | 'user' | 'server' | 'comment' | 'webhook' | 'viewer' | 'token';
export type Operation = 'get' | 'getAll' | 'getByName' | 'search' | 'getProjectComments' | 'markViewed' | 'filterObjects' | 'validateProperties' | 'updateProperties' | 'create' | 'update' | 'delete' | 'reply' | 'archive' | 'edit' | 'fetchGraph' | 'extractElementTable' | 'analyzeModel' | 'diff' | 'importFile' | 'downloadFile' | 'listBlobs' | 'validateIds' | 'invite' | 'remove' | 'getActivity' | 'getEmbedLink' | 'getTeam' | 'leave' | 'updateRole' | 'moveToModel' | 'markReceived' | 'transfer' | 'exportPayload' | 'importPayload' | 'revoke' | 'test';

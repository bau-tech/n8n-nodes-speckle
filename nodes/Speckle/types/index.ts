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

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  role: string;
  models?: Model[];
}

export interface Model {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  versions?: Version[];
}

export interface Version {
  id: string;
  message?: string;
  createdAt: string;
  sourceApplication?: string;
  authorId: string;
  referencedObject: string;
}

export type Resource = 'project' | 'model' | 'version' | 'object' | 'user' | 'server' | 'comment' | 'selection' | 'webhook' | 'viewer' | 'token';
export type Operation = 'get' | 'getAll' | 'getByName' | 'search' | 'query' | 'getProjectComments' | 'markViewed' | 'getParameters' | 'filterObjects' | 'validateProperties' | 'updateProperties' | 'create' | 'update' | 'delete' | 'reply' | 'archive' | 'edit' | 'fetchGraph' | 'getMetadata' | 'extractMetadata' | 'extractElementTable' | 'extractTeklaTable' | 'extractRevitTable' | 'analyzeModel' | 'diff' | 'flatten' | 'importFile' | 'downloadFile' | 'listBlobs' | 'validateIds' | 'getSelection' | 'invite' | 'remove' | 'getActivity' | 'traverse' | 'getEmbedLink' | 'getHtmlViewer' | 'getTeam' | 'leave' | 'updateRole' | 'moveToModel' | 'markReceived' | 'transfer' | 'exportPayload' | 'importPayload' | 'revoke' | 'test';
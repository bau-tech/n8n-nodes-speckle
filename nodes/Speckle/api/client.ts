import { IExecuteFunctions, ILoadOptionsFunctions } from 'n8n-workflow';
import { SpeckleError } from '../utils/errors';
import { GraphQLResponse, SpeckleCredentials } from '../types';

export class SpeckleClient {
  private readonly debug: boolean;

  constructor(
    private readonly executeFunctions: IExecuteFunctions | ILoadOptionsFunctions,
    private readonly credentials: SpeckleCredentials,
    debug?: boolean,
  ) {
    // Allow explicit per-node toggle, fall back to env var
    this.debug = debug === true || process.env.SPECKLE_DEBUG === '1';

    // Ensure serverUrl doesn't end with a slash
    if (this.credentials.serverUrl && this.credentials.serverUrl.endsWith('/')) {
      this.credentials.serverUrl = this.credentials.serverUrl.slice(0, -1);
    }
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private adaptGraphQLVariableTypes(query: string, errorText: string): string | null {
    if (!query || !errorText) {
      return null;
    }

    const normalizedErrorText = errorText
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n');
    const mismatchRegex = /Variable "\$(\w+)" of type "([^"]+)" used in position expecting type "([^"]+)"/g;
    let adaptedQuery = query;
    let changed = false;

    if (this.debug && normalizedErrorText !== errorText) {
      // eslint-disable-next-line no-console
      console.debug('[Speckle] Normalized GraphQL error text for compatibility retry');
    }

    for (const match of normalizedErrorText.matchAll(mismatchRegex)) {
      const [, variableName, currentType, expectedType] = match;
      const declarationRegex = new RegExp(`\\$${variableName}\\s*:\\s*${this.escapeRegExp(currentType)}`, 'g');

      if (declarationRegex.test(adaptedQuery)) {
        adaptedQuery = adaptedQuery.replace(declarationRegex, `$${variableName}: ${expectedType}`);
        changed = true;
      }
    }

    return changed ? adaptedQuery : null;
  }

  private mergeObjectMetadata(rawObject: any): any {
    if (!rawObject || typeof rawObject !== 'object') {
      return rawObject;
    }

    const baseData = rawObject.data;
    let merged = rawObject;

    if (typeof baseData === 'string') {
      merged = JSON.parse(baseData);
    } else if (baseData && typeof baseData === 'object') {
      merged = JSON.parse(JSON.stringify(baseData));
    }

    if (!merged || typeof merged !== 'object') {
      merged = { value: merged };
    }

    if (!merged.id && rawObject.id) {
      merged.id = rawObject.id;
    }
    if (!merged.applicationId && rawObject.applicationId) {
      merged.applicationId = rawObject.applicationId;
    }
    if (merged.totalChildrenCount == null && rawObject.totalChildrenCount != null) {
      merged.totalChildrenCount = rawObject.totalChildrenCount;
    }
    if (!merged.speckle_type) {
      if (rawObject.speckleType) {
        merged.speckle_type = rawObject.speckleType;
      } else if (merged.speckleType) {
        merged.speckle_type = merged.speckleType;
      }
    }

    return merged;
  }

  /**
   * Fetch object data using GraphQL (more reliable than REST API)
   * @param streamId - Project/Stream ID
   * @param objectId - Object ID to fetch
   * @returns Object data with all properties
   */
  async fetchObject(streamId: string, objectId: string): Promise<any> {
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.debug('[Speckle] Fetching object via GraphQL:', { streamId, objectId });
    }

    const query = `
      query GetObject($streamId: String!, $objectId: String!) {
        project(id: $streamId) {
          object(id: $objectId) {
            id
            speckleType
            applicationId
            totalChildrenCount
            data
          }
        }
      }
    `;

    try {
      const result = await this.makeGraphQLRequest(query, {
        streamId,
        objectId,
      });

      // DEBUG: Log the full response structure
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.debug('[Speckle] GraphQL Response:', JSON.stringify(result, null, 2));
      }

      if (!result?.project?.object) {
        throw new SpeckleError(
          this.executeFunctions.getNode(),
          `Object ${objectId} not found in project ${streamId}`
        );
      }

      const objectData = result.project.object;

      if (this.debug) {
        // eslint-disable-next-line no-console
        console.debug('[Speckle] Object data keys:', Object.keys(objectData));
        // eslint-disable-next-line no-console
        console.debug('[Speckle] Data type:', typeof objectData.data);
      }

      const mergedObject = this.mergeObjectMetadata(objectData);

      if (this.debug) {
        // eslint-disable-next-line no-console
        console.debug('[Speckle] Returning object with preserved metadata', {
          id: mergedObject?.id,
          speckle_type: mergedObject?.speckle_type,
          applicationId: mergedObject?.applicationId,
          totalChildrenCount: mergedObject?.totalChildrenCount,
        });
      }

      return mergedObject;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      // eslint-disable-next-line no-console
      console.error('[Speckle] fetchObject failed:', error);
      throw new SpeckleError(
        this.executeFunctions.getNode(),
        `Failed to fetch object: ${errorMessage}`
      );
    }
  }

  async makeGraphQLRequestDirect(query: string, variables?: any, allowCompatibilityRetry = true): Promise<any> {
    const debug = this.debug;
    const url = `${this.credentials.serverUrl}/graphql`;

    if (debug) {
      try {
        const maskedToken = this.credentials?.token
          ? `${this.credentials.token.slice(0, 4)}...${this.credentials.token.slice(-4)}`
          : 'no-token';
        // eslint-disable-next-line no-console
        console.debug('[Speckle] Direct GraphQL Request', {
          url,
          token: maskedToken,
          query: typeof query === 'string' ? query.slice(0, 1000) : query,
          variables,
        });
      } catch (e) {
        // ignore logging errors
      }
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });

      const rawBody = await response.text();
      const graphQLResponse: GraphQLResponse = rawBody ? JSON.parse(rawBody) : {};
      const parsedErrorMessages = Array.isArray(graphQLResponse?.errors)
        ? graphQLResponse.errors.map((entry: any) => entry?.message).filter(Boolean).join('\n')
        : '';
      const responseErrorText = [
        !response.ok ? rawBody : '',
        parsedErrorMessages,
        graphQLResponse.errors && graphQLResponse.errors.length ? JSON.stringify(graphQLResponse.errors) : '',
      ].filter(Boolean).join('\n');

      if (( !response.ok || (graphQLResponse.errors && graphQLResponse.errors.length) ) && allowCompatibilityRetry) {
        const adaptedQuery = this.adaptGraphQLVariableTypes(query, responseErrorText);
        if (adaptedQuery && adaptedQuery !== query) {
          if (debug) {
            // eslint-disable-next-line no-console
            console.debug('[Speckle] Retrying direct GraphQL request with adapted variable types', {
              variables,
              error: responseErrorText.slice(0, 500),
            });
          }
          return this.makeGraphQLRequestDirect(adaptedQuery, variables, false);
        }
      }

      if (!response.ok) {
        throw new SpeckleError(
          this.executeFunctions.getNode(),
          `GraphQL request failed: HTTP ${response.status} — ${rawBody.slice(0, 300)}`,
        );
      }

      if (graphQLResponse.errors && graphQLResponse.errors.length) {
        throw new SpeckleError(
          this.executeFunctions.getNode(),
          `GraphQL Error: ${JSON.stringify(graphQLResponse.errors)}`,
        );
      }

      if (!graphQLResponse || graphQLResponse.data == null) {
        throw new SpeckleError(
          this.executeFunctions.getNode(),
          'Empty response from Speckle API. Check destination server URL and token.',
        );
      }

      return graphQLResponse.data;
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      throw new SpeckleError(
        this.executeFunctions.getNode(),
        `Direct GraphQL request failed: ${errorMessage}`,
      );
    }
  }

  async makeGraphQLRequest(query: string, variables?: any, allowCompatibilityRetry = true): Promise<any> {
    const debug = this.debug;

    // Prepare request options
    const options = {
      method: 'POST' as const,
      url: `${this.credentials.serverUrl}/graphql`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        query,
        variables,
      },
      json: true,
    };

    if (debug) {
      try {
        const maskedToken = this.credentials?.token
          ? `${this.credentials.token.slice(0, 4)}...${this.credentials.token.slice(-4)}`
          : 'no-token';
        // Keep logs concise and avoid dumping full tokens
        // eslint-disable-next-line no-console
        console.debug('[Speckle] GraphQL Request', {
          url: options.url,
          token: maskedToken,
          query: typeof query === 'string' ? query.slice(0, 1000) : query,
          variables,
        });
      } catch (e) {
        // ignore logging errors
      }
    }

    try {
      // Use requestWithAuthentication so the credential's token is applied
      const response = await this.executeFunctions.helpers.requestWithAuthentication.call(
        this.executeFunctions,
        'speckleApi',
        options as any,
      );

      const graphQLResponse = response as GraphQLResponse;

      // If the API returns errors, surface them
      if (graphQLResponse.errors && graphQLResponse.errors.length) {
        if (debug) {
          // eslint-disable-next-line no-console
          console.debug('[Speckle] GraphQL Errors', graphQLResponse.errors);
        }

        if (allowCompatibilityRetry) {
          const adaptedQuery = this.adaptGraphQLVariableTypes(query, JSON.stringify(graphQLResponse.errors));
          if (adaptedQuery && adaptedQuery !== query) {
            if (debug) {
              // eslint-disable-next-line no-console
              console.debug('[Speckle] Retrying authenticated GraphQL request with adapted variable types', {
                variables,
                errors: graphQLResponse.errors,
              });
            }
            return await this.makeGraphQLRequest(adaptedQuery, variables, false);
          }
        }

        throw new SpeckleError(
          this.executeFunctions.getNode(),
          `GraphQL Error: ${JSON.stringify(graphQLResponse.errors)}`,
        );
      }

      // If data is empty (e.g. unauthenticated request), give a clear message
      if (!graphQLResponse || graphQLResponse.data == null) {
        if (debug) {
          // eslint-disable-next-line no-console
          console.debug('[Speckle] Empty response', graphQLResponse);
        }

        throw new SpeckleError(
          this.executeFunctions.getNode(),
          'Empty response from Speckle API. Check server URL and credentials (token).',
        );
      }

      if (debug) {
        try {
          // eslint-disable-next-line no-console
          console.debug('[Speckle] GraphQL Response (data)', graphQLResponse.data);
        } catch (e) { }
      }

      return graphQLResponse.data;
    } catch (error: any) {
      let errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      // Try to extract detailed error information from various possible structures
      if (error?.response?.data) {
        const responseData = error.response.data;
        if (responseData.errors && Array.isArray(responseData.errors)) {
          const graphQLErrors = responseData.errors.map((e: any) => e.message).join(', ');
          errorMessage = `GraphQL API Error: ${graphQLErrors}`;
        } else if (typeof responseData === 'string') {
          errorMessage = `API Error: ${responseData}`;
        } else {
          errorMessage += ` - Response Data: ${JSON.stringify(responseData)}`;
        }
      }

      // Include additional error details for debugging
      const errorDetails: any = {
        message: errorMessage,
        statusCode: error?.statusCode || error?.response?.statusCode,
        statusMessage: error?.statusMessage || error?.response?.statusMessage,
      };

      // Include request details if available
      if (error?.options?.body) {
        errorDetails.requestBody = error.options.body;
      }

      // Serialize full error for debugging (limit size)
      const fullErrorStr = JSON.stringify(error, Object.getOwnPropertyNames(error)).slice(0, 2000);

      if (debug) {
        // eslint-disable-next-line no-console
        console.error('[Speckle] Request failed - Full Error:', fullErrorStr);
        console.error('[Speckle] Error Details:', errorDetails);
        if (error?.response?.data) {
          console.error('[Speckle] Response Data:', JSON.stringify(error.response.data, null, 2));
        }
      }

      if (allowCompatibilityRetry) {
        const retryErrorText = [
          errorMessage,
          fullErrorStr,
          error?.description,
          error?.response?.data ? JSON.stringify(error.response.data) : '',
        ].filter(Boolean).join('\n');
        const adaptedQuery = this.adaptGraphQLVariableTypes(query, retryErrorText);
        if (adaptedQuery && adaptedQuery !== query) {
          if (debug) {
            // eslint-disable-next-line no-console
            console.debug('[Speckle] Retrying failed authenticated GraphQL request with adapted variable types', {
              variables,
              error: retryErrorText.slice(0, 500),
            });
          }
          return await this.makeGraphQLRequest(adaptedQuery, variables, false);
        }
      }

      // Include serialized error details in the thrown message for user visibility
      errorMessage += ` [Status: ${errorDetails.statusCode || 'unknown'}] [Debug: ${fullErrorStr.slice(0, 500)}]`;

      throw new SpeckleError(
        this.executeFunctions.getNode(),
        errorMessage
      );
    }
  }

  /**
   * Helper to make REST requests to the Speckle API
   */
  async makeRestRequest(endpoint: string, method: string = 'GET', body?: any): Promise<any> {
    const debug = this.debug;
    const options: any = {
      method,
      url: `${this.credentials.serverUrl}${endpoint}`,
      headers: {
        'Content-Type': 'application/json',
      },
      json: true,
    };

    if (body) {
      options.body = body;
    }

    if (debug) {
      // eslint-disable-next-line no-console
      console.debug('[Speckle] REST Request', {
        method,
        url: options.url,
        body
      });
    }

    try {
      const response = await this.executeFunctions.helpers.requestWithAuthentication.call(
        this.executeFunctions,
        'speckleApi',
        options
      );

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      if (debug) {
        // eslint-disable-next-line no-console
        console.error('[Speckle] REST Request failed', error);
      }
      throw new SpeckleError(
        this.executeFunctions.getNode(),
        `REST API request failed: ${errorMessage}`
      );
    }
  }

  /**
   * Fetches ALL descendant IDs of an object from the server's children index.
   * Used to rebuild __closure when it is not returned in the GraphQL data field.
   * Returns a map of { childId: depth } — depth is always 1 (the server does not
   * expose depth in the children query, but depth is only a performance hint).
   */
  async getObjectClosureIds(streamId: string, objectId: string): Promise<Record<string, number>> {
    const closure: Record<string, number> = {};
    let cursor: string | null = null;
    const query = `
      query GetObjectChildIds($streamId: String!, $objectId: String!, $cursor: String) {
        project(id: $streamId) {
          object(id: $objectId) {
            children(limit: 1000, cursor: $cursor, select: ["id"]) {
              cursor
              objects { data }
            }
          }
        }
      }
    `;
    do {
      const result = await this.makeGraphQLRequest(query, { streamId, objectId, cursor });
      const children = result?.project?.object?.children;
      if (!children?.objects?.length) break;
      for (const obj of children.objects) {
        if (obj?.data?.id) closure[obj.data.id] = 1;
      }
      cursor = children.cursor ?? null;
    } while (cursor);
    return closure;
  }

  /**
   * Upload objects to Speckle using the correct multipart/form-data encoding.
   * The Speckle server POST /objects/{streamId} endpoint rejects application/json;
   * it expects each batch as a JSON-stringified form field (batch1, batch2, …).
   * Returns the list of object IDs assigned by the server (newline-delimited in response).
   */
  async uploadObjects(streamId: string, objects: any[]): Promise<string[]> {
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.debug('[Speckle] Uploading objects via native fetch multipart', { streamId, count: objects.length });
    }

    // n8n's requestWithAuthentication sets Content-Type:application/json at the outer
    // request level when json:true (default), which overrides the multipart/form-data
    // boundary header that FormData needs — causing the server to silently discard the
    // body.  Use native fetch (Node 18+) with a manual Authorization header instead.
    const url = `${this.credentials.serverUrl}/objects/${streamId}`;
    const token = this.credentials.token;

    // Build multipart body: one field per batch, named batch1, batch2, ...
    // Each field value is a JSON array of objects with Content-Type application/json.
    const BATCH_SIZE = 500;
    const form = new FormData();
    let batchIndex = 1;
    for (let offset = 0; offset < objects.length; offset += BATCH_SIZE) {
      const batch = objects.slice(offset, offset + BATCH_SIZE);
      form.append(
        `batch${batchIndex++}`,
        new Blob([JSON.stringify(batch)], { type: 'application/json' }),
      );
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    const rawBody = await res.text();
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.debug('[Speckle] uploadObjects status:', res.status, 'body:', rawBody.slice(0, 300));
    }

    if (!res.ok) {
      throw new SpeckleError(
        this.executeFunctions.getNode(),
        `Object upload failed: HTTP ${res.status} — ${rawBody.slice(0, 200)}`,
      );
    }

    // Server returns a JSON array of uploaded IDs, or empty body on success.
    try {
      const parsed = JSON.parse(rawBody);
      if (Array.isArray(parsed)) return parsed.filter((id: any) => typeof id === 'string');
    } catch {
      // empty body or non-JSON — treat as success with no ID list
    }
    return [];
  }

  /**
   * Get object children by fetching the object and traversing it
   * Uses REST API: GET /streams/{streamId}/objects/{objectId}
   */
  async getObjectChildrenRest(streamId: string, objectId: string, limit: number): Promise<any[]> {
    // Fetch the root object
    const rootObject = await this.fetchObject(streamId, objectId);

    // DEBUG: Log root object structure to find where BIM elements are
    if (this.debug) {
      console.log('[Speckle] Root object keys:', Object.keys(rootObject));
      console.log('[Speckle] Root object speckleType:', rootObject.speckleType || rootObject.speckle_type);

      // Check common array properties
      if (rootObject.elements) console.log('[Speckle] Has elements array with', Array.isArray(rootObject.elements) ? rootObject.elements.length : typeof rootObject.elements);
      if (rootObject['@elements']) console.log('[Speckle] Has @elements with', Array.isArray(rootObject['@elements']) ? rootObject['@elements'].length : typeof rootObject['@elements']);
      if (rootObject.children) console.log('[Speckle] Has children array with', Array.isArray(rootObject.children) ? rootObject.children.length : typeof rootObject.children);
      if (rootObject.objects) console.log('[Speckle] Has objects array with', Array.isArray(rootObject.objects) ? rootObject.objects.length : typeof rootObject.objects);
    }

    // Initialize collection
    const children: any[] = [];
    let count = 0;

    // Set to track visited objects to prevent cycles
    const visited = new Set<any>();

    // Set to track already-fetched reference IDs
    const fetchedRefs = new Set<string>();

    // Reference stubs commonly appear as siblings in the same array/object (e.g. an
    // 'elements' array with hundreds of {referencedId} entries) — resolving them one at a
    // time via sequential await was the dominant slowness for large models. This resolves
    // up to REF_BATCH_SIZE sibling references concurrently, then hands back an array where
    // each slot is either the original non-reference value, the fetched object, or null
    // (fetch failed, or the referencedId was already resolved via another branch) — the
    // caller traverses that array in the exact same order it would have without batching.
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
          if (this.debug) {
            console.log('[Speckle] Resolving reference:', refId);
          }
          try {
            return await this.fetchObject(streamId, refId);
          } catch (err) {
            if (this.debug) {
              console.warn('[Speckle] Failed to fetch reference:', refId, err);
            }
            return null;
          }
        }));
        pending.forEach(({ index }, i) => { resolved[index] = fetched[i]; });
      }

      return resolved;
    };

    const traverse = async (node: any) => {
      if (count >= limit) return;
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;

      visited.add(node);

      // Check for speckle type
      // We look for 'speckle_type' (standard) or 'speckleType' (some older/graphql variants)
      const type = node.speckle_type || node.speckleType;
      if (type) {

        if (type === 'reference' && node.referencedId && !fetchedRefs.has(node.referencedId)) {
          fetchedRefs.add(node.referencedId);
          if (this.debug) {
            console.log('[Speckle] Resolving reference:', node.referencedId);
          }
          try {
            const referencedObj = await this.fetchObject(streamId, node.referencedId);
            await traverse(referencedObj);
          } catch (err) {
            if (this.debug) {
              console.warn('[Speckle] Failed to fetch reference:', node.referencedId, err);
            }
          }
          return; // Don't collect the reference itself
        }
        // Filter out metadata and non-BIM objects
        const isGeometry = type.includes('Objects.Geometry.') &&
          !type.includes('Element') &&  // Keep Element1D, Element2D, etc.
          !type.includes('Member');     // Keep structural members

        const isMetadata =
          type.includes('Collection') ||
          type === 'reference' ||
          type.includes('RenderMaterial') ||
          type.includes('View') ||
          type.includes('DisplayValue') ||
          type.includes('DataChunk') ||
          type.includes('Objects.Primitive');
        // Only collect BIM elements
        if (!isGeometry && !isMetadata) {
          children.push({ data: node });
          count++;
        }


      }

      // Arrays and object properties are processed in batches so that any sibling
      // reference stubs within a batch are fetched concurrently instead of one at a time;
      // each batch is still consumed in original order before starting the next.
      const values = Array.isArray(node)
        ? node
        : Object.keys(node)
          .filter((key) => Object.prototype.hasOwnProperty.call(node, key))
          .map((key) => node[key]);

      for (let start = 0; start < values.length; start += REF_BATCH_SIZE) {
        if (count >= limit) break;
        const batch = values.slice(start, start + REF_BATCH_SIZE);
        const resolvedBatch = await resolveSiblingBatch(batch);
        for (const resolved of resolvedBatch) {
          if (count >= limit) break;
          await traverse(resolved);
        }
      }
    };

    await traverse(rootObject);
    return children;
  }
  /**
   * Runs the paginated "object children" GraphQL query with a caller-supplied
   * top-level field allow-list, and filters out pure-geometry results.
   * Shared by getObjectMetadata() (comprehensive list) and
   * getObjectMetadataDynamic() (minimal list for classification-only reads).
   */
  private async queryObjectMetadata(
    streamId: string,
    objectId: string,
    limit: number,
    cursor: string | null,
    selectFields: string[],
  ): Promise<{ objects: any[], cursor: string | null, totalCount: number }> {
    const selectString = selectFields.map(f => `"${f}"`).join(', ');

    const query = `
      query GetObjectMetadata($streamId: String!, $objectId: String!, $limit: Int, $cursor: String) {
        project(id: $streamId) {
          object(id: $objectId) {
            children(
              limit: $limit,
              cursor: $cursor,
              select: [${selectString}]
            ) {
              totalCount
              cursor
              objects {
                data
              }
            }
          }
        }
      }
    `;

    const result = await this.makeGraphQLRequest(query, {
      streamId,
      objectId,
      limit,
      cursor
    });

    if (!result?.project?.object?.children) {
      return { objects: [], cursor: null, totalCount: 0 };
    }

    const { objects, cursor: nextCursor, totalCount } = result.project.object.children;

    // The 'data' field in the response contains the actual object properties selected
    const cleanObjects = objects.map((o: any) => o.data);

    // Filter out pure geometry objects (Meshes, Lines, etc.)
    const filteredObjects = cleanObjects.filter((obj: any) => {
      const type = obj.speckle_type || obj.speckleType || '';

      // Skip pure geometry nodes unless they are semantic Elements/Members
      const isGeometry = type.includes('Objects.Geometry.') &&
        !type.includes('Element') &&  // Keep Element1D, Element2D, etc.
        !type.includes('Member');     // Keep structural members

      return !isGeometry;
    });

    return {
      objects: filteredObjects,
      cursor: nextCursor,
      totalCount
    };
  }

  /**
   * Retrieves specific metadata fields for object children, excluding geometry.
   * Leverages server-side filtering via GraphQL 'select' to optimize payload size.
   *
   * @param streamId The project/stream ID
   * @param objectId The parent object ID
   * @param limit Max number of children to return
   * @param cursor Pagination cursor
   */
  async getObjectMetadata(
    streamId: string,
    objectId: string,
    limit: number = 1000,
    cursor: string | null = null
  ): Promise<{ objects: any[], cursor: string | null, totalCount: number }> {

    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log('[Speckle] Fetching metadata only (no geometry) for:', objectId);
    }

    // Fields to retrieve (Allow-list approach).
    // This allows fetching BIM data without heavy geometry like 'displayValue', 'vertices', 'faces'.
    const selectFields = [
      "id",
      "speckle_type",
      "speckleType",
      "applicationId",
      "totalChildrenCount",
      "createdAt",

      // Common metadata & BIM Properties (Revit, IFC, Tekla, etc.)
      "name",
      "category",
      "family",
      "type",
      "level",
      "properties",
      "parameters",
      "elementId",
      "units",

      // Specific keys often used by Tekla / Structural / IFC
      "class",                  // Tekla (legacy)
      "classNumber",            // Tekla (new connector)
      "material",               // Structural
      "profile",                // Structural
      "grade",                  // Tekla/Structural
      "finish",                 // Tekla surface treatment
      "area",                   // Tekla/Structural quantity
      "volume",                 // Tekla/Structural quantity
      "attributes",             // Generic attributes
      "userDefinedAttributes",  // Tekla (legacy top-level)
      "userProperties",         // Tekla (new connector — flat UDAs + Report)
      "info"                    // General info objects
    ];

    try {
      return await this.queryObjectMetadata(streamId, objectId, limit, cursor, selectFields);
    } catch (error) {
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.error('[Speckle] getObjectMetadata failed:', error);
      }
      throw error;
    }
  }

  /**
   * Application-aware metadata retrieval for model analytics (Object → Analyze Model).
   * Analytics only classifies each element by type/category (see
   * metadataExtractor.normalizeElementCategory / detectSourceApplicationId) — it never
   * reads Instance/Type Parameters, Report, or Property Sets — so this requests a much
   * smaller top-level field set than getObjectMetadata's comprehensive list, cutting
   * payload size for large models. `sourceApplication` is accepted for logging/future
   * use; the selected fields already cover every application (Revit/Tekla/IFC/etc.)
   * since classification reads the same handful of fields regardless of source app.
   *
   * @param streamId The project/stream ID
   * @param objectId The parent object ID
   * @param sourceApplication Source application name (e.g., "Revit 2024")
   * @param limit Max number of children to return
   * @param cursor Pagination cursor
   */
  async getObjectMetadataDynamic(
    streamId: string,
    objectId: string,
    sourceApplication?: string,
    limit: number = 1000,
    cursor: string | null = null
  ): Promise<{ objects: any[], cursor: string | null, totalCount: number }> {

    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log('[Speckle] Fetching metadata with application-aware selection:', {
        objectId,
        sourceApplication,
        limit
      });
    }

    // Minimal allow-list: only what buildModelAnalytics/normalizeElementCategory/
    // detectSourceApplicationId/isRealBIMElement actually read. 'properties' is kept
    // whole (rather than narrowed to e.g. 'properties.category') because the select
    // argument here only supports top-level field names, not nested paths.
    const selectFields = [
      "id",
      "speckle_type",
      "speckleType",
      "applicationId",
      "category",
      "family",
      "type",
      "profile",
      "properties",
    ];

    try {
      const result = await this.queryObjectMetadata(streamId, objectId, limit, cursor, selectFields);

      if (this.debug) {
        // eslint-disable-next-line no-console
        console.log('[Speckle] Retrieved', result.objects.length, 'objects using application-aware minimal metadata query');
      }

      return result;
    } catch (error) {
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.error('[Speckle] getObjectMetadataDynamic failed:', error);
      }
      throw error;
    }
  }
}
import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';
import { queries } from './graphql/queries';
import { mutations } from './graphql/mutations';
import { SpeckleClient } from './api/client';
import { SpeckleError } from './utils/errors';
import { Resource, Operation, SpeckleCredentials } from './types';

import { validateObjectsAgainstIds } from './utils/idsValidator';
import { buildModelAnalytics, extractElementRow, extractMetadataFromObject, isRealBIMElement, detectSourceApplicationId } from './metadataExtractor';

import axios from 'axios';
import crypto from 'crypto';

// Helper to clean input IDs (remove whitespace, extract from URLs)
function cleanSpeckleId(input: string): string {
	if (!input) return '';
	const trimmed = input.trim();
	// Check if it's a URL
	if (trimmed.startsWith('http')) {
		try {
			const url = new URL(trimmed);
			// Handle project URLs (e.g. /projects/123)
			const pathParts = url.pathname.split('/').filter(p => p.length > 0);
			
			// Check for 'projects' or 'streams'
			const projIdx = pathParts.findIndex(p => p === 'projects' || p === 'streams');
			if (projIdx !== -1 && pathParts[projIdx + 1]) {
				return pathParts[projIdx + 1];
			}
			// If we can't find a keyword, but it's a URL, maybe the user passed a direct link to a model/version
			// For now, we mainly want to fix the Project ID issue.
		} catch (e) {
			// If URL parsing fails, just return trimmed
		}
	}
	return trimmed;
}

type SpeckleIdKind = 'project' | 'model' | 'version';

// Which kind of ID each resource-locator parameter holds
const ID_PARAMETER_KINDS: Record<string, SpeckleIdKind> = {
	projectId: 'project',
	modelId: 'model',
	objectVersionModelId: 'model',
	targetModelId: 'model',
	versionId: 'version',
	versionAId: 'version',
	versionBId: 'version',
};

// Turns a resource-locator value (or a plain string from an expression) into a bare ID.
// Speckle URLs look like /projects/{projectId}/models/{modelId}@{versionId}.
function resolveSpeckleId(raw: any, kind: SpeckleIdKind): string {
	const value = raw && typeof raw === 'object' ? raw.value : raw;
	const text = String(value ?? '').trim();
	if (!/^https?:\/\//i.test(text)) return text;

	let match: RegExpMatchArray | null;
	if (kind === 'project') {
		match = text.match(/\/(?:projects|streams)\/([^/?#@,]+)/);
	} else if (kind === 'model') {
		match = text.match(/\/models\/([^/?#@,]+)/);
	} else {
		match = text.match(/@([^/?#@,]+)/);
	}
	return match ? match[1] : text;
}

function idLocator(
	kind: SpeckleIdKind,
	name: string,
	displayName: string,
	description: string,
	show: NonNullable<NonNullable<INodeProperties['displayOptions']>['show']>,
	hide?: NonNullable<INodeProperties['displayOptions']>['hide'],
	required = true,
): INodeProperties {
	const searchListMethod = { project: 'searchProjects', model: 'searchModels', version: 'searchVersions' }[kind];
	const urlPlaceholder = {
		project: 'https://app.speckle.systems/projects/abc123def4',
		model: 'https://app.speckle.systems/projects/abc123def4/models/0123456789',
		version: 'https://app.speckle.systems/projects/abc123def4/models/0123456789@fedcba9876',
	}[kind];

	return {
		displayName,
		name,
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required,
		description,
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod, searchable: true },
			},
			{
				displayName: 'By URL',
				name: 'url',
				type: 'string',
				placeholder: urlPlaceholder,
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'abc123def4',
			},
		],
		displayOptions: hide ? { show, hide } : { show },
	};
}

const OBJECT_VERSION_OPERATIONS = ['getAll', 'filterObjects', 'extractElementTable', 'analyzeModel', 'updateProperties'];

const SPECKLE_ID_FIELDS: INodeProperties[] = [
	idLocator('project', 'projectId', 'Project', 'The Speckle project', {
		resource: ['project'],
		operation: ['get', 'update', 'delete', 'importFile', 'downloadFile', 'listBlobs', 'invite', 'remove', 'getActivity', 'getTeam', 'leave', 'updateRole', 'transfer', 'exportPayload'],
	}),
	idLocator(
		'project', 'projectId', 'Project', 'The Speckle project',
		{ resource: ['model', 'version', 'object', 'comment', 'webhook', 'viewer'] },
		{ operation: ['importPayload', 'validateIds'] },
	),
	idLocator('model', 'modelId', 'Model', 'The model to import the file into', {
		resource: ['project'],
		operation: ['importFile'],
	}),
	idLocator('model', 'modelId', 'Model', 'The Speckle model', {
		resource: ['model'],
		operation: ['get', 'update', 'delete', 'transfer', 'exportPayload'],
	}),
	idLocator('model', 'modelId', 'Model', 'The Speckle model', {
		resource: ['version'],
		operation: ['create', 'getAll', 'get', 'diff', 'transfer', 'exportPayload'],
	}),
	idLocator('model', 'modelId', 'Model', 'The Speckle model', {
		resource: ['object', 'viewer'],
		operation: [...OBJECT_VERSION_OPERATIONS, 'getEmbedLink'],
	}),
	idLocator('version', 'versionId', 'Version', 'The version of the model', {
		resource: ['version'],
		operation: ['get', 'update', 'delete', 'markReceived', 'transfer', 'exportPayload'],
	}),
	idLocator('version', 'versionId', 'Version', 'The version of the model', {
		resource: ['object', 'viewer'],
		operation: [...OBJECT_VERSION_OPERATIONS, 'getEmbedLink'],
	}),
	idLocator('version', 'versionAId', 'Version A (Old)', 'The older version to compare', {
		resource: ['version'],
		operation: ['diff'],
	}),
	idLocator('version', 'versionBId', 'Version B (New)', 'The newer version to compare', {
		resource: ['version'],
		operation: ['diff'],
	}),
];

// Compact per-element row for Object > Get Many (Summary output)
function summariseElement(data: any, sourceApplication?: string): Record<string, any> {
	const props = data.properties ?? {};
	const family = data.family ?? props.family;
	const type = data.type ?? props.type;
	const ifcType = data.ifcType ?? props.ifcType;
	const profile = data.profile ?? props.profile;
	const unbox = (group: any): Record<string, any> => {
		const flat: Record<string, any> = {};
		if (!group || typeof group !== 'object') return flat;
		for (const [key, val] of Object.entries(group)) {
			flat[key] = val && typeof val === 'object' && 'value' in (val as any) ? (val as any).value : val;
		}
		return flat;
	};

	// Revit: v3 connectors nest under properties.Parameters, v2 directly under properties
	const revitGroups = props.Parameters ?? props;
	const ifcProps: Record<string, any> = {};
	for (const pset of Object.values(props['Property Sets'] ?? {})) {
		if (pset && typeof pset === 'object') Object.assign(ifcProps, pset);
	}

	return {
		id: data.id,
		speckleType: data.speckleType || data.speckle_type,
		sourceApplication,
		elementType: ifcType || (family && type ? `${family}:${type}` : null) || profile || data.speckleType || data.speckle_type || 'Unknown',
		name: data.name,
		category: data.category,
		family,
		type,
		ifcType,
		profile,
		material: data.material ?? props.material,
		parameters: {
			...data.parameters,
			...props.parameters,
			...(props.userDefinedAttributes ?? props['User Defined Attributes']),
			...unbox(props.Report),
			...unbox(revitGroups['Instance Parameters']),
			...unbox(revitGroups['Type Parameters']),
			...ifcProps,
		},
	};
}

type TransferVersionMode = 'none' | 'latest' | 'all';

async function findProjectByName(client: SpeckleClient, name: string): Promise<any | null> {
	let cursor: string | null = null;
	const normalizedName = name.trim().toLowerCase();

	do {
		const response = await client.makeGraphQLRequestDirect(queries.listProjects, { limit: 100, cursor });
		const projects = response?.activeUser?.projects?.items ?? [];
		const match = projects.find((project: any) => String(project.name ?? '').trim().toLowerCase() === normalizedName);
		if (match) {
			return match;
		}
		cursor = response?.activeUser?.projects?.cursor ?? null;
	} while (cursor);

	return null;
}

async function findModelByName(client: SpeckleClient, projectId: string, name: string): Promise<any | null> {
	let cursor: string | null = null;
	const normalizedName = name.trim().toLowerCase();

	do {
		const response = await client.makeGraphQLRequestDirect(queries.getModels, { projectId, limit: 100, cursor });
		const models = response?.project?.models?.items ?? [];
		const match = models.find((model: any) => String(model.name ?? '').trim().toLowerCase() === normalizedName);
		if (match) {
			return match;
		}
		cursor = response?.project?.models?.cursor ?? null;
	} while (cursor);

	return null;
}

async function ensureDestinationProject(
	client: SpeckleClient,
	sourceProject: any,
	destinationProjectId: string,
	destinationProjectName: string,
	visibility: string,
): Promise<{ id: string; name: string; created: boolean; reusedExisting: boolean }> {
	if (destinationProjectId) {
		return {
			id: destinationProjectId,
			name: destinationProjectName || sourceProject?.name || destinationProjectId,
			created: false,
			reusedExisting: false,
		};
	}

	const targetName = (destinationProjectName || sourceProject?.name || 'Transferred Project').trim();
	const existingProject = await findProjectByName(client, targetName);
	if (existingProject) {
		return {
			id: existingProject.id,
			name: existingProject.name,
			created: false,
			reusedExisting: true,
		};
	}

	const response = await client.makeGraphQLRequestDirect(mutations.projectCreate, {
		input: {
			name: targetName,
			description: sourceProject?.description || '',
			visibility,
		},
	});
	const createdProject = response?.projectMutations?.create;

	return {
		id: createdProject.id,
		name: createdProject.name,
		created: true,
		reusedExisting: false,
	};
}

async function ensureDestinationModel(
	client: SpeckleClient,
	destinationProjectId: string,
	sourceModel: any,
	destinationModelId: string,
	destinationModelName: string,
): Promise<{ id: string; name: string; created: boolean; reusedExisting: boolean }> {
	if (destinationModelId) {
		return {
			id: destinationModelId,
			name: destinationModelName || sourceModel?.name || destinationModelId,
			created: false,
			reusedExisting: false,
		};
	}

	const targetName = (destinationModelName || sourceModel?.name || 'Transferred Model').trim();
	const existingModel = await findModelByName(client, destinationProjectId, targetName);
	if (existingModel) {
		return {
			id: existingModel.id,
			name: existingModel.name,
			created: false,
			reusedExisting: true,
		};
	}

	const response = await client.makeGraphQLRequestDirect(mutations.modelCreate, {
		projectId: destinationProjectId,
		name: targetName,
		description: sourceModel?.description || '',
	});
	const createdModel = response?.modelMutations?.create;

	return {
		id: createdModel.id,
		name: createdModel.name,
		created: true,
		reusedExisting: false,
	};
}

async function listProjectModels(client: SpeckleClient, projectId: string): Promise<any[]> {
	const models: any[] = [];
	let cursor: string | null = null;

	do {
		const response = await client.makeGraphQLRequest(queries.getModels, { projectId, limit: 100, cursor });
		models.push(...(response?.project?.models?.items ?? []));
		cursor = response?.project?.models?.cursor ?? null;
	} while (cursor);

	return models;
}

async function listModelVersions(
	client: SpeckleClient,
	projectId: string,
	modelId: string,
	mode: TransferVersionMode,
): Promise<any[]> {
	if (mode === 'none') {
		return [];
	}

	const versions: any[] = [];
	let cursor: string | null = null;
	const limit = mode === 'latest' ? 1 : 100;

	do {
		const response = await client.makeGraphQLRequest(queries.getModelVersions, { projectId, modelId, limit, cursor });
		versions.push(...(response?.project?.model?.versions?.items ?? []));
		cursor = mode === 'latest' ? null : response?.project?.model?.versions?.cursor ?? null;
	} while (cursor);

	if (mode === 'all') {
		versions.sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
	}

	return versions;
}

function collectReferencedObjectIds(node: any, referencedIds: Set<string>): void {
	if (!node || typeof node !== 'object') {
		return;
	}

	if (Array.isArray(node)) {
		for (const item of node) {
			collectReferencedObjectIds(item, referencedIds);
		}
		return;
	}

	if (typeof node.referencedId === 'string' && node.referencedId.trim() !== '') {
		referencedIds.add(node.referencedId.trim());
	}

	for (const [key, value] of Object.entries(node)) {
		if (key === '__closure' || key === 'id' || key === 'referencedId') {
			continue;
		}
		if (value && typeof value === 'object') {
			collectReferencedObjectIds(value, referencedIds);
		}
	}
}

async function collectObjectGraph(client: SpeckleClient, projectId: string, rootObjectId: string): Promise<any[]> {
	const pendingIds: string[] = [rootObjectId];
	const queuedIds = new Set<string>([rootObjectId]);
	const objectById = new Map<string, any>();
	const BATCH_SIZE = 12;

	while (pendingIds.length > 0) {
		const batchIds = pendingIds.splice(0, BATCH_SIZE);
		const batchObjects = await Promise.all(batchIds.map((id) => client.fetchObject(projectId, id)));

		for (let index = 0; index < batchObjects.length; index++) {
			const objectId = batchIds[index];
			const sourceObject = batchObjects[index];
			if (!sourceObject || typeof sourceObject !== 'object') {
				continue;
			}

			const objectCopy = JSON.parse(JSON.stringify(sourceObject));
			objectCopy.id = String(objectCopy.id || objectId).trim();
			if (!objectCopy.speckle_type && objectCopy.speckleType) {
				objectCopy.speckle_type = objectCopy.speckleType;
			}
			objectById.set(objectCopy.id, objectCopy);

			const referencedIds = new Set<string>();
			collectReferencedObjectIds(objectCopy, referencedIds);
			for (const referencedId of referencedIds) {
				if (!queuedIds.has(referencedId)) {
					queuedIds.add(referencedId);
					pendingIds.push(referencedId);
				}
			}
		}
	}

	const rootCopy = objectById.get(rootObjectId);
	if (rootCopy && (!rootCopy.__closure || Object.keys(rootCopy.__closure).length === 0)) {
		const closure: Record<string, number> = {};
		for (const objectId of objectById.keys()) {
			if (objectId !== rootObjectId) {
				closure[objectId] = 1;
			}
		}
		if (Object.keys(closure).length > 0) {
			rootCopy.__closure = closure;
		}
	}

	const orderedObjects = Array.from(objectById.values()).filter((obj) => obj?.id !== rootObjectId);
	if (rootCopy) {
		orderedObjects.push(rootCopy);
	}

	return orderedObjects;
}

async function resolveUploadedRootObjectId(
	client: SpeckleClient,
	projectId: string,
	preferredRootId: string,
	uploadedIds: string[],
): Promise<string> {
	const candidates = [preferredRootId, ...uploadedIds.filter((id) => id && id !== preferredRootId)];

	for (const candidateId of candidates) {
		try {
			await client.fetchObject(projectId, candidateId);
			return candidateId;
		} catch {
			continue;
		}
	}

	return preferredRootId;
}

async function transferVersionToServer(params: {
	sourceClient: SpeckleClient;
	targetClient: SpeckleClient;
	sourceProjectId: string;
	sourceProject: any;
	sourceModel: any;
	sourceVersion: any;
	destinationProjectId: string;
	destinationModelId: string;
	commitPrefix: string;
	sourceServerUrl: string;
	uploadedObjectIdsCache?: Set<string>;
}): Promise<any> {
	const referencedObjectId = params.sourceVersion?.referencedObject;
	if (!referencedObjectId) {
		throw new SpeckleError(
			(params.sourceClient as any)['executeFunctions'].getNode(),
			`Referenced object not found for version ${params.sourceVersion?.id}`,
		);
	}

	const objectsToUpload = await collectObjectGraph(params.sourceClient, params.sourceProjectId, referencedObjectId);
	const pendingObjects = objectsToUpload.filter((obj) => {
		const objectId = String(obj?.id ?? '').trim();
		return objectId !== '' && !params.uploadedObjectIdsCache?.has(objectId);
	});
	const uploadedIds = pendingObjects.length > 0
		? await params.targetClient.uploadObjects(params.destinationProjectId, pendingObjects)
		: [];
	for (const obj of objectsToUpload) {
		const objectId = String(obj?.id ?? '').trim();
		if (objectId !== '') {
			params.uploadedObjectIdsCache?.add(objectId);
		}
	}
	const destinationRootObjectId = await resolveUploadedRootObjectId(
		params.targetClient,
		params.destinationProjectId,
		referencedObjectId,
		uploadedIds,
	);

	const prefix = params.commitPrefix.trim();
	const baseMessage = params.sourceVersion?.message || `Transferred version ${params.sourceVersion?.id}`;
	const message = `${prefix ? `${prefix} ` : ''}${baseMessage} (from ${params.sourceServerUrl})`;

	const response = await params.targetClient.makeGraphQLRequestDirect(mutations.versionCreate, {
		projectId: params.destinationProjectId,
		modelId: params.destinationModelId,
		objectId: destinationRootObjectId,
		message,
	});

	const destinationVersion = response?.versionMutations?.create;
	const sourceApplicationResult = await preserveVersionSourceApplication(
		params.targetClient,
		params.destinationProjectId,
		destinationVersion?.id,
		params.sourceVersion?.sourceApplication,
		'Preserved source application after transfer',
	);

	return {
		sourceVersionId: params.sourceVersion?.id,
		destinationVersion,
		referencedObjectId: destinationRootObjectId,
		sourceReferencedObjectId: referencedObjectId,
		objectCount: objectsToUpload.length,
		uploadedObjectCount: pendingObjects.length,
		sourceApplication: params.sourceVersion?.sourceApplication ?? null,
		sourceApplicationPreserved: sourceApplicationResult.success,
		sourceApplicationWarning: sourceApplicationResult.warning,
	};
}

async function preserveVersionSourceApplication(
	client: SpeckleClient,
	projectId: string,
	versionId: string | undefined,
	sourceApplication?: string,
	message?: string,
): Promise<{ success: boolean; warning?: string }> {
	if (!versionId || !sourceApplication || sourceApplication.trim() === '') {
		return { success: false };
	}

	try {
		const response = await client.makeGraphQLRequest(mutations.versionMarkReceived, {
			projectId,
			versionId,
			sourceApplication,
			message: message || undefined,
		});
		return { success: Boolean(response?.versionMutations?.markReceived) };
	} catch (error: any) {
		return {
			success: false,
			warning: error?.message || 'Failed to preserve source application on the new version.',
		};
	}
}

async function buildTransferPayload(params: {
	resourceType: 'project' | 'model' | 'version';
	sourceClient: SpeckleClient;
	sourceServerUrl: string;
	projectId: string;
	modelId?: string;
	versionId?: string;
	versionMode: TransferVersionMode;
	node: IExecuteFunctions;
}): Promise<any> {
	const sourceProjectResp = await params.sourceClient.makeGraphQLRequest(queries.getProject, {
		projectId: params.projectId,
		modelLimit: 0,
	});
	const sourceProject = sourceProjectResp?.project;
	if (!sourceProject) {
		throw new SpeckleError(params.node.getNode(), `Project not found: ${params.projectId}`);
	}

	let sourceModels: any[] = [];
	if (params.resourceType === 'project') {
		sourceModels = await listProjectModels(params.sourceClient, params.projectId);
	} else {
		const sourceModelResp = await params.sourceClient.makeGraphQLRequest(queries.getModel, {
			projectId: params.projectId,
			modelId: params.modelId,
		});
		const sourceModel = sourceModelResp?.project?.model;
		if (!sourceModel) {
			throw new SpeckleError(params.node.getNode(), `Model not found: ${params.modelId}`);
		}
		sourceModels = [sourceModel];
	}

	const payloadModels: any[] = [];
	const sharedObjectStore = new Map<string, any>();
	for (const sourceModel of sourceModels) {
		let sourceVersions: any[] = [];

		if (params.resourceType === 'version') {
			const sourceVersionResp = await params.sourceClient.makeGraphQLRequest(queries.getVersionObjects, {
				projectId: params.projectId,
				modelId: params.modelId,
				versionId: params.versionId,
			});
			const sourceVersion = sourceVersionResp?.project?.model?.version;
			if (!sourceVersion) {
				throw new SpeckleError(params.node.getNode(), `Version not found: ${params.versionId}`);
			}
			sourceVersions = [sourceVersion];
		} else {
			sourceVersions = await listModelVersions(
				params.sourceClient,
				params.projectId,
				sourceModel.id,
				params.versionMode,
			);
		}

		const payloadVersions: any[] = [];
		for (const sourceVersion of sourceVersions) {
			const referencedObjectId = sourceVersion?.referencedObject;
			if (!referencedObjectId) {
				continue;
			}

			const objects = await collectObjectGraph(params.sourceClient, params.projectId, referencedObjectId);
			const objectIds: string[] = [];
			for (const obj of objects) {
				const objectId = String(obj?.id ?? '').trim();
				if (objectId === '') {
					continue;
				}
				objectIds.push(objectId);
				if (!sharedObjectStore.has(objectId)) {
					sharedObjectStore.set(objectId, obj);
				}
			}
			payloadVersions.push({
				id: sourceVersion.id,
				message: sourceVersion.message,
				createdAt: sourceVersion.createdAt,
				sourceApplication: sourceVersion.sourceApplication,
				referencedObjectId,
				objectCount: objectIds.length,
				objectIds,
			});
		}

		payloadModels.push({
			id: sourceModel.id,
			name: sourceModel.name,
			description: sourceModel.description,
			versions: payloadVersions,
		});
	}

	return {
		__transferPayload: true,
		payloadVersion: 2,
		resourceType: params.resourceType,
		sourceServerUrl: params.sourceServerUrl,
		exportedAt: new Date().toISOString(),
		versionMode: params.versionMode,
		sourceProject: {
			id: sourceProject.id,
			name: sourceProject.name,
			description: sourceProject.description,
		},
		models: payloadModels,
		objectStore: Array.from(sharedObjectStore.values()),
		objectStoreCount: sharedObjectStore.size,
	};
}

async function importTransferPayloadToServer(params: {
	targetClient: SpeckleClient;
	payload: any;
	destinationProjectId: string;
	destinationProjectName: string;
	destinationModelId: string;
	destinationModelName: string;
	visibility: string;
	commitPrefix: string;
	node: IExecuteFunctions;
}): Promise<any> {
	const payload = params.payload?.transferPayload ?? params.payload;
	if (!payload || payload.__transferPayload !== true) {
		throw new SpeckleError(
			params.node.getNode(),
			'No valid transfer payload found in the incoming item. Use Export Transfer Payload in the first Speckle node.',
		);
	}

	const destinationProject = await ensureDestinationProject(
		params.targetClient,
		payload.sourceProject,
		params.destinationProjectId,
		params.destinationProjectName,
		params.visibility,
	);

	const payloadModels = Array.isArray(payload.models) ? payload.models : [];
	const payloadObjectStore = new Map<string, any>();
	for (const obj of Array.isArray(payload.objectStore) ? payload.objectStore : []) {
		const objectId = String(obj?.id ?? '').trim();
		if (objectId !== '') {
			payloadObjectStore.set(objectId, obj);
		}
	}
	const uploadedObjectIdsCache = new Set<string>();
	const transferredModels: any[] = [];

	for (let modelIndex = 0; modelIndex < payloadModels.length; modelIndex++) {
		const modelPayload = payloadModels[modelIndex];
		const useOverrideModel = payloadModels.length === 1 && modelIndex === 0;
		const destinationModel = await ensureDestinationModel(
			params.targetClient,
			destinationProject.id,
			modelPayload,
			useOverrideModel ? params.destinationModelId : '',
			useOverrideModel ? params.destinationModelName : '',
		);

		const versions = Array.isArray(modelPayload.versions) ? modelPayload.versions : [];
		const transferredVersions: any[] = [];

		for (const versionPayload of versions) {
			const versionObjectIds = Array.isArray(versionPayload.objectIds)
				? versionPayload.objectIds.map((id: any) => String(id ?? '').trim()).filter((id: string) => id !== '')
				: [];
			const objects = versionObjectIds.length > 0
				? versionObjectIds.map((id: string) => payloadObjectStore.get(id)).filter(Boolean)
				: (Array.isArray(versionPayload.objects) ? versionPayload.objects : []);
			const pendingObjects = objects.filter((obj: any) => {
				const objectId = String(obj?.id ?? '').trim();
				return objectId !== '' && !uploadedObjectIdsCache.has(objectId);
			});
			if (objects.length === 0 && !uploadedObjectIdsCache.has(String(versionPayload.referencedObjectId ?? '').trim())) {
				continue;
			}

			const uploadedIds = pendingObjects.length > 0
				? await params.targetClient.uploadObjects(destinationProject.id, pendingObjects)
				: [];
			for (const obj of objects) {
				const objectId = String(obj?.id ?? '').trim();
				if (objectId !== '') {
					uploadedObjectIdsCache.add(objectId);
				}
			}
			const destinationRootObjectId = await resolveUploadedRootObjectId(
				params.targetClient,
				destinationProject.id,
				versionPayload.referencedObjectId,
				uploadedIds,
			);

			const prefix = params.commitPrefix.trim();
			const baseMessage = versionPayload.message || `Transferred version ${versionPayload.id}`;
			const message = `${prefix ? `${prefix} ` : ''}${baseMessage} (from ${payload.sourceServerUrl})`;
			const response = await params.targetClient.makeGraphQLRequestDirect(mutations.versionCreate, {
				projectId: destinationProject.id,
				modelId: destinationModel.id,
				objectId: destinationRootObjectId,
				message,
			});
			const destinationVersion = response?.versionMutations?.create;
			const sourceApplicationResult = await preserveVersionSourceApplication(
				params.targetClient,
				destinationProject.id,
				destinationVersion?.id,
				versionPayload.sourceApplication,
				'Preserved source application after payload import',
			);

			transferredVersions.push({
				sourceVersionId: versionPayload.id,
				destinationVersion,
				referencedObjectId: destinationRootObjectId,
				sourceReferencedObjectId: versionPayload.referencedObjectId,
				objectCount: objects.length,
				uploadedObjectCount: pendingObjects.length,
				sourceApplication: versionPayload.sourceApplication ?? null,
				sourceApplicationPreserved: sourceApplicationResult.success,
				sourceApplicationWarning: sourceApplicationResult.warning,
			});
		}

		transferredModels.push({
			sourceModelId: modelPayload.id,
			sourceModelName: modelPayload.name,
			destinationModelId: destinationModel.id,
			destinationModelName: destinationModel.name,
			versionsTransferred: transferredVersions.length,
			transferredVersions,
		});
	}

	return {
		resourceType: payload.resourceType,
		sourceServerUrl: payload.sourceServerUrl,
		destinationProject,
		modelsTransferred: transferredModels.length,
		transferredModels,
		objectStoreCount: payloadObjectStore.size,
		uploadedObjectCount: uploadedObjectIdsCache.size,
	};
}

export class Speckle implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Speckle',
		name: 'speckle',
		icon: 'file:speckle.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Interact with Speckle projects, models, and objects',
		defaults: {
			name: 'Speckle',
		},
		inputs: ['main'],
		outputs: ['main'],
		usableAsTool: true,
		credentials: [
			{
				name: 'speckleApi',
				required: true,
			},
		],
		properties: [
			// Resource selector
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Project',
						value: 'project',
					},
					{
						name: 'Model',
						value: 'model',
					},
					{
						name: 'Object',
						value: 'object',
					},
					{
						name: 'Version',
						value: 'version',
					},
					{
						name: 'User',
						value: 'user',
					},
					{
						name: 'Server',
						value: 'server',
					},
					{
						name: 'Comment',
						value: 'comment',
					},
					{
						name: 'Webhook',
						value: 'webhook',
					},
					{
						name: 'Viewer',
						value: 'viewer',
					},
					{
						name: 'Token',
						value: 'token',
					},
				],
				default: 'project',
			},

			// Enable debug logging toggle
			{
				displayName: 'Enable Debug Logging',
				name: 'enableDebug',
				type: 'boolean',
				default: false,
				description: 'When enabled, the node will log GraphQL request/response details to the server console (masked token).',
			},

			// Project Operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['project'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Create a new project',
						action: 'Create a project',
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Update a project',
						action: 'Update a project',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a project',
						action: 'Delete a project',
					},
					{
						name: 'Import File',
						value: 'importFile',
						description: 'Upload and import a file (IFC, OBJ, etc.)',
						action: 'Import a file',
					},
					{
						name: 'Download File',
						value: 'downloadFile',
						description: 'Download a file (blob) by ID',
						action: 'Download a file',
					},
					{
						name: 'List Blobs',
						value: 'listBlobs',
						description: 'List all blobs (files) in a project',
						action: 'List all blobs',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get a project by ID',
						action: 'Get a project',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List all accessible projects',
						action: 'Get many projects',
					},
					{
						name: 'Get By Name',
						value: 'getByName',
						description: 'Find a project by its exact name (case-insensitive)',
						action: 'Get a project by name',
					},
					{
						name: 'Search',
						value: 'search',
						description: 'Search projects by name or description',
						action: 'Search projects',
					},
					{
						name: 'Get Team',
						value: 'getTeam',
						description: 'List all collaborators and their roles',
						action: 'Get project team members',
					},
					{
						name: 'Invite User',
						value: 'invite',
						description: 'Invite a user to a project',
						action: 'Invite a user to a project',
					},
					{
						name: 'Update Role',
						value: 'updateRole',
						description: 'Update or remove a collaborator role',
						action: 'Update collaborator role',
					},
					{
						name: 'Remove User',
						value: 'remove',
						description: 'Remove a user from a project',
						action: 'Remove a user from a project',
					},
					{
						name: 'Leave',
						value: 'leave',
						description: 'Leave a project',
						action: 'Leave a project',
					},
					{
						name: 'Get Activity',
						value: 'getActivity',
						description: 'List the most recent versions across all models of a project',
						action: 'Get project activity',
					},
					{
						name: 'Transfer To Server',
						value: 'transfer',
						description: 'Copy this project and its selected content to another Speckle server',
						action: 'Transfer a project to another server',
					},
					{
						name: 'Export Transfer Payload',
						value: 'exportPayload',
						description: 'Export this project as a transferable payload for a second Speckle node to import',
						action: 'Export project transfer payload',
					},
					{
						name: 'Import Transfer Payload',
						value: 'importPayload',
						description: 'Import a project transfer payload produced by another Speckle node',
						action: 'Import project transfer payload',
					},
				],
				default: 'getAll',
			},

			// Model Operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['model'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Create a new model',
						action: 'Create a model',
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Update a model',
						action: 'Update a model',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get a model by ID',
						action: 'Get a model',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List all models in a project',
						action: 'Get many models',
					},
					{
						name: 'Get By Name',
						value: 'getByName',
						description: 'Find a model by its exact name within a project (case-insensitive)',
						action: 'Get a model by name',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a model',
						action: 'Delete a model',
					},
					{
						name: 'Transfer To Server',
						value: 'transfer',
						description: 'Copy this model and its selected versions to another Speckle server',
						action: 'Transfer a model to another server',
					},
					{
						name: 'Export Transfer Payload',
						value: 'exportPayload',
						description: 'Export this model as a transferable payload for a second Speckle node to import',
						action: 'Export model transfer payload',
					},
					{
						name: 'Import Transfer Payload',
						value: 'importPayload',
						description: 'Import a model transfer payload produced by another Speckle node',
						action: 'Import model transfer payload',
					},
				],
				default: 'getAll',
			},

			// Version Operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['version'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Create a new version/commit',
						action: 'Create a version',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List all versions for a model',
						action: 'Get many versions',
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Update a version message',
						action: 'Update a version',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a version',
						action: 'Delete a version',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get a single version by ID',
						action: 'Get a version',
					},
					{
						name: 'Diff',
						value: 'diff',
						description: 'Compare two versions and return differences',
						action: 'Diff two versions',
					},
					{
						name: 'Move To Model',
						value: 'moveToModel',
						description: 'Move one or more versions to a different model',
						action: 'Move versions to model',
					},
					{
						name: 'Mark Received',
						value: 'markReceived',
						description: 'Mark a version as received by an application',
						action: 'Mark version as received',
					},
					{
						name: 'Transfer To Server',
						value: 'transfer',
						description: 'Copy this version and its full object graph to another Speckle server',
						action: 'Transfer a version to another server',
					},
					{
						name: 'Export Transfer Payload',
						value: 'exportPayload',
						description: 'Export this version as a transferable payload for a second Speckle node to import',
						action: 'Export version transfer payload',
					},
					{
						name: 'Import Transfer Payload',
						value: 'importPayload',
						description: 'Import a version transfer payload produced by another Speckle node',
						action: 'Import version transfer payload',
					},
				],
				default: 'getAll',
			},

			// Object Operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['object'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Create a new object from raw JSON, optionally as a new version',
						action: 'Create an object',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get the elements of a version as summary rows, flattened rows, or raw objects (no geometry)',
						action: 'Get many objects',
					},
					{
						name: 'Filter Objects',
						value: 'filterObjects',
						description: 'Return the elements of a version that match a property filter',
						action: 'Filter objects by property',
					},
					{
						name: 'Extract Element Table',
						value: 'extractElementTable',
						description: 'Extract a flat table with one row per element, with IFC, Revit, or Tekla specific columns',
						action: 'Extract element table',
					},
					{
						name: 'Generate Model Analytics',
						value: 'analyzeModel',
						description: 'Generate chart-ready analytics for a model version, including element counts for beams, floors, columns, walls, and more.',
						action: 'Generate model analytics',
					},
					{
						name: 'Fetch Graph',
						value: 'fetchGraph',
						description: 'Fetch an object by ID together with everything it references, including geometry',
						action: 'Fetch object graph',
					},
					{
						name: 'Validate IDS',
						value: 'validateIds',
						description: 'Validate objects against an IDS file',
						action: 'Validate objects against IDS',
					},
					{
						name: 'Object Property Validation',
						value: 'validateProperties',
						description: 'Validate selected object properties with checks like equals, greater than, smaller than, has value, true, or false.',
						action: 'Validate object properties',
					},
					{
						name: 'Update Properties',
						value: 'updateProperties',
						description: 'Update specific properties of an object and optionally create a new version',
						action: 'Update object properties',
					},
				],
				default: 'getAll',
			},

			// Object Data (for object create)
			{
				displayName: 'Object Data',
				name: 'objectData',
				type: 'json',
				required: true,
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['create'],
					},
				},
				default: '{}',
				description: 'Raw JSON payload for the new Speckle object, e.g. { "name": "Sensor Reading", "value": 42 }. "speckle_type" defaults to "Base" if omitted.',
			},

			// Also Create Version toggle (for object create)
			{
				displayName: 'Also Create Version',
				name: 'createVersion',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['create'],
					},
				},
				description: 'Whether to create a new version pointing at the uploaded object',
			},

			// Target Model (if creating a version)
			idLocator(
				'model', 'objectVersionModelId', 'Target Model', 'The model to create the new version in',
				{ resource: ['object'], operation: ['create'], createVersion: [true] },
			),

			// Version Message (if creating a version)
			{
				displayName: 'Version Message',
				name: 'objectVersionMessage',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['create'],
						createVersion: [true],
					},
				},
				default: 'Created via n8n',
				description: 'The message for the new version',
			},

			// User Operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['user'],
					},
				},
				options: [
					{
						name: 'Get Active User',
						value: 'get',
						description: 'Get active user details',
						action: 'Get active user',
					},
					{
						name: 'Search',
						value: 'search',
						description: 'Search for users by name or email',
						action: 'Search users',
					},
				],
				default: 'get',
			},

			// Server Operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['server'],
					},
				},
				options: [
					{
						name: 'Get',
						value: 'get',
						description: 'Get server information',
						action: 'Get server info',
					},
				],
				default: 'get',
			},

			// Comment Operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['comment'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Create a comment',
						action: 'Create a comment',
					},
					{
						name: 'Reply',
						value: 'reply',
						description: 'Reply to a comment',
						action: 'Reply to a comment',
					},
					{
						name: 'Archive',
						value: 'archive',
						description: 'Archive a comment thread',
						action: 'Archive a comment',
					},
					{
						name: 'Edit',
						value: 'edit',
						description: 'Edit an existing comment',
						action: 'Edit a comment',
					},
					{
						name: 'Get Project Comments',
						value: 'getProjectComments',
						description: 'Get comments for a project',
						action: 'Get project comments',
					},
					{
						name: 'Mark Viewed',
						value: 'markViewed',
						description: 'Mark a comment thread as viewed by you',
						action: 'Mark a comment as viewed',
					},
				],
				default: 'getProjectComments',
			},

			// Webhook Operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['webhook'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Create a new webhook',
						action: 'Create a webhook',
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Update an existing webhook',
						action: 'Update a webhook',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a webhook',
						action: 'Delete a webhook',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get a single webhook by ID',
						action: 'Get a webhook',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List webhooks for a project',
						action: 'Get many webhooks',
					},
					{
						name: 'Test',
						value: 'test',
						description: 'Send a synthetic test payload to the webhook URL to verify connectivity',
						action: 'Send a test payload to a webhook',
					},
				],
				default: 'getAll',
			},

			// Viewer Operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['viewer'],
					},
				},
				options: [
					{
						name: 'Get Embed Link',
						value: 'getEmbedLink',
						description: 'Get an embeddable link for the Speckle Viewer',
						action: 'Get viewer embed link',
					},
				],
				default: 'getEmbedLink',
			},

			// Token Operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['token'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Create a new personal API token',
						action: 'Create an API token',
					},
					{
						name: 'Revoke',
						value: 'revoke',
						description: 'Revoke (delete) an API token',
						action: 'Revoke an API token',
					},
				],
				default: 'create',
			},





			// Project / Model / Version pickers (list, URL or ID)
			...SPECKLE_ID_FIELDS,

			// User Email (for Invite)
			{
				displayName: 'User Email',
				name: 'userEmail',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['invite'],
					},
				},
				default: '',
				description: 'Email of the user to invite',
			},

			// User Role (for Invite)
			{
				displayName: 'Role',
				name: 'userRole',
				type: 'options',
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['invite'],
					},
				},
				options: [
					{ name: 'Stream Owner', value: 'stream:owner' },
					{ name: 'Stream Contributor', value: 'stream:contributor' },
					{ name: 'Stream Reviewer', value: 'stream:reviewer' },
				],
				default: 'stream:contributor',
				description: 'Role to assign to the user',
			},

			// Target User ID (for Remove / UpdateRole)
			{
				displayName: 'User ID',
				name: 'targetUserId',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['remove', 'updateRole'],
					},
				},
				default: '',
				description: 'ID of the user to remove or update',
			},

			// Role for updateRole
			{
				displayName: 'New Role',
				name: 'newRole',
				type: 'options',
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['updateRole'],
					},
				},
				options: [
					{ name: 'Owner', value: 'stream:owner' },
					{ name: 'Contributor', value: 'stream:contributor' },
					{ name: 'Reviewer', value: 'stream:reviewer' },
					{ name: 'Remove Access', value: '' },
				],
				default: 'stream:contributor',
				description: 'The new role for the user. Select "Remove Access" to revoke membership.',
			},


			{
				displayName: 'Message',
				name: 'versionMessage',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['version'],
						operation: ['update'],
					},
				},
				default: '',
				description: 'New message for the version',
			},
			{
				displayName: 'Detailed Diff',
				name: 'detailedDiff',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['version'],
						operation: ['diff'],
					},
				},
				description: 'When enabled, fetches full objects to identify specific property changes (slower).',
			},

			// Object ID for fetchGraph
			{
				displayName: 'Object ID',
				name: 'objectId',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['fetchGraph', 'validateProperties', 'updateProperties'],
					},
				},
				default: '',
				description: 'The ID of the root object to fetch',
			},



			// ============================================
			// TRANSFER TO ANOTHER SPECKLE SERVER
			// ============================================
			{
				displayName: 'Destination Server URL',
				name: 'destinationServerUrl',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['project', 'model', 'version'],
						operation: ['transfer'],
					},
				},
				default: 'https://app.speckle.systems',
				description: 'The URL of the destination Speckle server',
			},
			{
				displayName: 'Destination Personal Access Token',
				name: 'destinationToken',
				type: 'string',
				typeOptions: {
					password: true,
				},
				required: true,
				displayOptions: {
					show: {
						resource: ['project', 'model', 'version'],
						operation: ['transfer'],
					},
				},
				default: '',
				description: 'Personal access token for the destination Speckle server',
			},
			{
				displayName: 'Destination Visibility',
				name: 'destinationVisibility',
				type: 'options',
				options: [
					{ name: 'Private', value: 'PRIVATE' },
					{ name: 'Public', value: 'PUBLIC' },
					{ name: 'Unlisted', value: 'UNLISTED' },
				],
				default: 'PRIVATE',
				displayOptions: {
					show: {
						resource: ['project', 'model', 'version'],
						operation: ['transfer', 'importPayload'],
					},
				},
				description: 'Visibility to use when a new destination project is created',
			},
			{
				displayName: 'Destination Project ID',
				name: 'destinationProjectId',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['project', 'model', 'version'],
						operation: ['transfer', 'importPayload'],
					},
				},
				default: '',
				description: 'Optional existing project on the destination server. Leave empty to create or reuse one by name.',
			},
			{
				displayName: 'Destination Project Name',
				name: 'destinationProjectName',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['project', 'model', 'version'],
						operation: ['transfer', 'importPayload'],
					},
				},
				default: '',
				description: 'Optional override for the destination project name. If left empty, the source project name is used.',
			},
			{
				displayName: 'Destination Model ID',
				name: 'destinationModelId',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['model', 'version'],
						operation: ['transfer', 'importPayload'],
					},
				},
				default: '',
				description: 'Optional existing model on the destination server. Leave empty to create or reuse one by name.',
			},
			{
				displayName: 'Destination Model Name',
				name: 'destinationModelName',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['model', 'version'],
						operation: ['transfer', 'importPayload'],
					},
				},
				default: '',
				description: 'Optional override for the destination model name. If left empty, the source model name is used.',
			},
			{
				displayName: 'Transfer Versions',
				name: 'transferVersionMode',
				type: 'options',
				options: [
					{ name: 'Structure Only', value: 'none' },
					{ name: 'Latest Version', value: 'latest' },
					{ name: 'All Versions', value: 'all' },
				],
				default: 'latest',
				displayOptions: {
					show: {
						resource: ['project', 'model'],
						operation: ['transfer', 'exportPayload'],
					},
				},
				description: 'Choose how much version history to copy when transferring a project or model',
			},
			{
				displayName: 'Commit Message Prefix',
				name: 'transferCommitPrefix',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['project', 'model', 'version'],
						operation: ['transfer', 'importPayload'],
					},
				},
				default: '[Transferred]',
				description: 'Prefix added to new version messages created on the destination server',
			},

			// Search query
			{
				displayName: 'Search Query',
				name: 'query',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['project', 'user'],
						operation: ['search'],
					},
				},
				default: '',
				description: 'Search term for project names and descriptions',
			},

			// Binary Property (for file upload)
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				displayOptions: {
					show: {
						resource: ['project', 'object'],
						operation: ['importFile', 'validateIds'],
					},
				},
				description: 'The name of the binary property containing the file to upload or validate',
			},

			// Blob ID (for file download)
			{
				displayName: 'Blob ID',
				name: 'blobId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['downloadFile'],
					},
				},
				description: 'The ID of the blob (file) to download',
			},

			// Object query - User-friendly interface
		{
			displayName: 'Property to Search',
			name: 'propertyToSearch',
			type: 'options',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['filterObjects'],
				},
			},
			options: [
				{
					name: 'Category',
					value: 'category',
					description: 'Search by element category (e.g., Walls, Doors, Windows)',
				},
				{
					name: 'Speckle Type',
					value: 'speckleType',
					description: 'Search by Speckle object class. On newer connectors every BIM element shares the same class (e.g. "Objects.Data.RevitObject"), so this cannot distinguish a wall from a door — use Category instead for element-type filtering.',
				},
				{
					name: 'Family (Revit)',
					value: 'properties.family',
					description: 'Search by Revit family name',
				},
				{
					name: 'Type (Revit)',
					value: 'properties.type',
					description: 'Search by Revit type name',
				},
				{
					name: 'IFC Type',
					value: 'properties.ifcType',
					description: 'Search by IFC element type',
				},
				{
					name: 'Material',
					value: 'properties.material',
					description: 'Search by material name',
				},
				{
					name: 'Level',
					value: 'properties.level',
					description: 'Search by level/floor',
				},
				{
					name: 'Custom Property',
					value: 'custom',
					description: 'Search by a custom property name',
				},
			],
			default: 'category',
			description: 'Select which property to search',
		},
		{
			displayName: 'Custom Property Name',
			name: 'customPropertyName',
			type: 'string',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['filterObjects'],
					propertyToSearch: ['custom'],
				},
			},
			default: '',
			placeholder: 'e.g., FireRating, ThermalTransmittance',
			description: 'Enter the exact property name to search for',
		},
		{
			displayName: 'Match Type',
			name: 'matchType',
			type: 'options',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['filterObjects'],
				},
			},
			options: [
				{
					name: 'Property Exists (Any Value)',
					value: 'exists',
					description: 'Find objects that have this property, regardless of value',
				},
				{
					name: 'Contains Value',
					value: 'contains',
					description: 'Find objects where property value contains the search text (case-insensitive)',
				},
				{
					name: 'Equals Value',
					value: 'equals',
					description: 'Find objects where property value exactly matches (case-insensitive)',
				},
			],
			default: 'contains',
			description: 'How to match the property value',
		},
		{
			displayName: 'Search Value',
			name: 'searchValue',
			type: 'string',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['filterObjects'],
					matchType: ['contains', 'equals'],
				},
			},
			default: '',
			placeholder: 'e.g., Wall, Concrete, Level 1',
			description: 'The value to search for in the selected property',
		},

			{
				displayName: 'Output',
				name: 'filterOutput',
				type: 'options',
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['filterObjects'],
					},
				},
				options: [
					{ name: 'Matching Objects', value: 'objects', description: 'One item per matching object, with its full metadata' },
					{ name: 'Match Summary', value: 'summary', description: 'A single item listing the matched IDs, keys and values' },
				],
				default: 'objects',
				description: 'What to return for the matches',
			},

			// Max nodes to inspect when doing a client-side property query
			{
				displayName: 'Max Nodes To Inspect',
				name: 'maxNodesToInspect',
				type: 'number',
				default: 1000,
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['filterObjects'],
					},
				},
				description: 'Maximum number of nodes to traverse when searching an object (guards against huge models).',
			},


			// Get Many (object) options
			{
				displayName: 'Output',
				name: 'elementOutput',
				type: 'options',
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['getAll'],
					},
				},
				options: [
					{ name: 'Summary', value: 'summary', description: 'Key fields per element plus a single "parameters" object' },
					{ name: 'Flattened', value: 'flat', description: 'All properties flattened to columns, tuned to the source application' },
					{ name: 'Raw', value: 'raw', description: 'Objects exactly as stored, including containers. Useful to inspect real property names.' },
				],
				default: 'summary',
				description: 'How each element is shaped in the output. Geometry is never included.',
			},
			{
				displayName: 'Include Geometry Properties',
				name: 'includeGeometry',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['getAll'],
						elementOutput: ['flat'],
					},
				},
				description: 'Include basic geometry properties (volume, area, length) in the output',
			},
			{
				displayName: 'Flatten Nested Properties',
				name: 'flattenNested',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['getAll'],
						elementOutput: ['flat'],
					},
				},
				description: 'Flatten all nested properties to top level (e.g., properties.family becomes family)',
			},

			// ============================================
			// OBJECT PROPERTY VALIDATION OPTIONS
			// ============================================
			{
				displayName: 'Validation Mode',
				name: 'validationMode',
				type: 'options',
				options: [
					{ name: 'All Rules Must Pass', value: 'all' },
					{ name: 'Any Rule Can Pass', value: 'any' },
				],
				default: 'all',
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['validateProperties'],
					},
				},
				description: 'Choose whether all validation rules must pass or if any single rule can pass.',
			},
			{
				displayName: 'Validation Rules',
				name: 'validationRules',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['validateProperties'],
					},
				},
				placeholder: 'Add Validation Rule',
				default: {},
				options: [
					{
						displayName: 'Rule',
						name: 'rules',
						values: [
							{
								displayName: 'Property Path',
								name: 'propertyPath',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getObjectPropertyPaths',
									loadOptionsDependsOn: ['projectId', 'objectId'],
								},
								options: [],
								default: '',
								description: 'Select an existing property path from the object. The list is loaded from the current Object ID.',
							},
							{
								displayName: 'Custom Property Path',
								name: 'customPropertyPath',
								type: 'string',
								default: '',
								placeholder: 'e.g., properties.parameters.FireRating',
								description: 'Optional manual path. Use this when the dropdown does not contain the field you want to validate.',
							},
							{
								displayName: 'Check',
								name: 'checkType',
								type: 'options',
								options: [
									{ name: 'Equal', value: 'equals' },
									{ name: 'Not Equal', value: 'notEquals' },
									{ name: 'Greater Than', value: 'greaterThan' },
									{ name: 'Greater Than or Equal', value: 'greaterThanOrEqual' },
									{ name: 'Smaller Than', value: 'lessThan' },
									{ name: 'Smaller Than or Equal', value: 'lessThanOrEqual' },
									{ name: 'Contains', value: 'contains' },
									{ name: 'Has Value', value: 'hasValue' },
									{ name: 'Is Empty', value: 'isEmpty' },
									{ name: 'Is True', value: 'isTrue' },
									{ name: 'Is False', value: 'isFalse' },
								],
								default: 'hasValue',
								description: 'Choose how the value should be validated.',
							},
							{
								displayName: 'Value Type',
								name: 'valueType',
								type: 'options',
								options: [
									{ name: 'Auto Detect', value: 'auto' },
									{ name: 'String', value: 'string' },
									{ name: 'Integer', value: 'integer' },
									{ name: 'Double', value: 'double' },
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'Date', value: 'date' },
								],
								default: 'auto',
								description: 'Choose how the actual and expected values should be compared.',
							},
							{
								displayName: 'Expected Value',
								name: 'expectedValue',
								type: 'string',
								default: '',
								description: 'The value to compare against for checks like Equal, Greater Than, or Contains.',
							},
						],
					},
				],
			},

			// ============================================
			// UPDATE PROPERTIES OPTIONS
			// ============================================
			{
				displayName: 'Properties to Update',
				name: 'propertiesToUpdate',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['updateProperties'],
					},
				},
				placeholder: 'Add Property',
				default: {},
				options: [
					{
						displayName: 'Property',
						name: 'propertyValues',
						values: [
							{
								displayName: 'Property Path',
								name: 'propertyPath',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getObjectPropertyPaths',
									loadOptionsDependsOn: ['projectId', 'objectId'],
								},
								options: [],
								default: '',
								description: 'Select an existing property path from the object. The list is loaded from the current Object ID.',
							},
							{
								displayName: 'Custom Property Path',
								name: 'customPropertyPath',
								type: 'string',
								default: '',
								placeholder: 'e.g., properties.parameters.Comments',
								description: 'Optional manual path. Use this when you want to create a new path or if the dropdown does not contain the field you need.',
							},
							{
								displayName: 'Value Type',
								name: 'valueType',
								type: 'options',
								options: [
									{ name: 'Auto Detect', value: 'auto' },
									{ name: 'String', value: 'string' },
									{ name: 'Integer', value: 'integer' },
									{ name: 'Double', value: 'double' },
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'Date', value: 'date' },
								],
								default: 'auto',
								description: 'Choose how the new value should be stored when the property is updated or created.',
							},
							{
								displayName: 'New Value',
								name: 'value',
								type: 'string',
								default: '',
								description: 'Enter the new value. It will be converted using the selected Value Type.',
							},
						],
					},
				],
			},
			{
				displayName: 'Create Missing Paths',
				name: 'createMissingPaths',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['updateProperties'],
					},
				},
				description: 'Whether to create properties that do not already exist on the object. Keep this off to avoid accidentally using a current value like "BEAM" instead of a field name like "name".',
			},

			// Auto-Commit Option
			{
				displayName: 'Auto-Commit Changes',
				name: 'autoCommit',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['updateProperties'],
					},
				},
				description: 'Whether to automatically create a new version with the updated object',
			},

			// Target Model (if auto-commit is on)
			idLocator(
				'model', 'targetModelId', 'Target Model', 'The model to create the new version in',
				{ resource: ['object'], operation: ['updateProperties'], autoCommit: [true] },
			),

			// Commit Message
			{
				displayName: 'Commit Message',
				name: 'commitMessage',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['updateProperties'],
						autoCommit: [true],
					},
				},
				default: 'Updated properties via n8n',
				description: 'The message for the new version',
			},
			{
			displayName: 'Property Prefix',
			name: 'propertyPrefix',
			type: 'options',
			options: [
				{ name: 'No Prefix', value: 'none' },
				{ name: 'Source Type (e.g., revit_Height)', value: 'source' },
				{ name: 'Property Path (e.g., Instance_Parameters_Height)', value: 'path' },
			],
			default: 'none',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['getAll'],
					elementOutput: ['flat'],
				},
			},
			description: 'How to prefix property names to avoid conflicts',
		},
		{
			displayName: 'Application Hint',
			name: 'applicationHint',
			type: 'options',
			options: [
				{ name: 'Auto-detect', value: 'auto' },
				{ name: 'Revit', value: 'Revit' },
				{ name: 'Tekla', value: 'Tekla' },
				{ name: 'IFC', value: 'IFC' },
				{ name: 'Rhino', value: 'Rhino' },
				{ name: 'Archicad', value: 'Archicad' },
				{ name: 'Generic', value: 'Generic' },
			],
			default: 'auto',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['analyzeModel'],
				},
			},
			description: 'Manually specify the source application if auto-detection fails. This helps optimize metadata extraction for application-specific property structures.',
		},
		{
			displayName: 'Application Hint',
			name: 'applicationHint',
			type: 'options',
			options: [
				{ name: 'Auto-detect', value: 'auto' },
				{ name: 'Revit', value: 'Revit' },
				{ name: 'Tekla', value: 'Tekla' },
				{ name: 'IFC', value: 'IFC' },
				{ name: 'Rhino', value: 'Rhino' },
				{ name: 'Archicad', value: 'Archicad' },
				{ name: 'Generic', value: 'Generic' },
			],
			default: 'auto',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['getAll'],
					elementOutput: ['flat'],
				},
			},
			description: 'Manually specify the source application if auto-detection fails. This helps optimize metadata extraction for application-specific property structures.',
		},

		// ============================================
		// EXTRACT ELEMENT TABLE OPTIONS
		// ============================================
		{
			displayName: 'Source Application',
			name: 'tableSource',
			type: 'options',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['extractElementTable'],
				},
			},
			options: [
				{ name: 'Auto-detect', value: 'auto', description: 'Use each element\'s own source application; no elements are skipped' },
				{ name: 'IFC', value: 'ifc', description: 'Only IFC elements, with IFC property sets as columns' },
				{ name: 'Revit', value: 'revit', description: 'Only Revit elements, with category filtering and Revit parameter columns' },
				{ name: 'Tekla', value: 'tekla', description: 'Only Tekla Structures elements, with element-type filtering and user properties' },
			],
			default: 'auto',
			description: 'Which elements to include and which application-specific columns to produce',
		},
		{
			displayName: 'Element Type',
			name: 'teklaElementTypes',
			type: 'options',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['extractElementTable'],
					tableSource: ['tekla'],
				},
			},
			options: [
				{ name: 'All Types (mixed columns)', value: 'all' },
				// Structural members
				{ name: 'Beam (straight beams & columns)', value: 'Beam' },
				{ name: 'PolyBeam (multi-leg beams)', value: 'PolyBeam' },
				{ name: 'SpiralBeam', value: 'SpiralBeam' },
				{ name: 'ContourPlate (plates, pads, slabs)', value: 'ContourPlate' },
				// Reinforcement
				{ name: 'RebarGroup (bent rebar groups)', value: 'RebarGroup' },
				{ name: 'CurvedRebarGroup', value: 'CurvedRebarGroup' },
				{ name: 'StraightRebarGroup', value: 'StraightRebarGroup' },
				{ name: 'SingleRebar', value: 'SingleRebar' },
				{ name: 'RebarMesh', value: 'RebarMesh' },
				// Bolts
				{ name: 'BoltArray (rectangular bolt pattern)', value: 'BoltArray' },
				{ name: 'BoltXYList (XY position bolt pattern)', value: 'BoltXYList' },
				{ name: 'BoltCircle (circular bolt pattern)', value: 'BoltCircle' },
				// Connections / misc
				{ name: 'Weld', value: 'Weld' },
				{ name: 'PolygonWeld', value: 'PolygonWeld' },
				{ name: 'BooleanPart (cuts / openings)', value: 'BooleanPart' },
				{ name: 'Fitting', value: 'Fitting' },
			],
			default: 'all',
			description: 'Pick one element type to get a clean table where every row has the same columns. Type names match Tekla Structures API class names.',
		},
		{
			displayName: 'Include User Properties (UDAs)',
			name: 'includeUserProperties',
			type: 'boolean',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['extractElementTable'],
					tableSource: ['tekla'],
				},
			},
			default: true,
			description: 'Whether to include Tekla user-defined attributes (UDAs) and Report properties as additional columns',
		},
		{
			displayName: 'Max Elements',
			name: 'maxElements',
			type: 'number',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['getAll', 'extractElementTable', 'analyzeModel'],
				},
			},
			default: 0,
			description: 'Maximum number of elements to return. Set to 0 for unlimited (streams all pages). Useful for testing on large models.',
		},
		{
			displayName: 'Batch Size',
			name: 'batchSize',
			type: 'number',
			typeOptions: {
				minValue: 50,
				maxValue: 1000,
			},
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['getAll', 'extractElementTable', 'analyzeModel'],
				},
			},
			default: 500,
			description: 'Number of elements fetched per server request. Reduce if you experience timeouts on large models.',
		},
		{
			displayName: 'Top Categories for Charts',
			name: 'analyticsTopCategories',
			type: 'number',
			typeOptions: {
				minValue: 3,
				maxValue: 25,
			},
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['analyzeModel'],
				},
			},
			default: 10,
			description: 'Maximum number of top element categories to include in the chart-ready analytics output.',
		},
		{
			displayName: 'Analytics Output Format',
			name: 'analyticsOutputFormat',
			type: 'options',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['analyzeModel'],
				},
			},
			options: [
				{ name: 'Metabase Rows (Recommended)', value: 'metabase' },
				{ name: 'Both Structured + Metabase', value: 'both' },
				{ name: 'Structured JSON Only', value: 'structured' },
			],
			default: 'metabase',
			description: 'Choose a flat row-based output for Metabase dashboards, or keep the full structured analytics JSON.',
		},

		// ============================================
		// REVIT-SPECIFIC ELEMENT TABLE OPTIONS
		// ============================================
		{
			displayName: 'Category',
			name: 'revitCategory',
			type: 'options',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['extractElementTable'],
					tableSource: ['revit'],
				},
			},
			options: [
				{ name: 'All Categories (mixed columns)', value: 'all' },
				// Architecture
				{ name: 'Ceilings', value: 'Ceilings' },
				{ name: 'Columns', value: 'Columns' },
				{ name: 'Curtain Panels', value: 'Curtain Panels' },
				{ name: 'Curtain Wall Mullions', value: 'Curtain Wall Mullions' },
				{ name: 'Doors', value: 'Doors' },
				{ name: 'Floors', value: 'Floors' },
				{ name: 'Generic Models', value: 'Generic Models' },
				{ name: 'Railings', value: 'Railings' },
				{ name: 'Ramps', value: 'Ramps' },
				{ name: 'Roofs', value: 'Roofs' },
				{ name: 'Rooms', value: 'Rooms' },
				{ name: 'Stairs', value: 'Stairs' },
				{ name: 'Walls', value: 'Walls' },
				{ name: 'Windows', value: 'Windows' },
				// Structure
				{ name: 'Structural Columns', value: 'Structural Columns' },
				{ name: 'Structural Foundations', value: 'Structural Foundations' },
				{ name: 'Structural Framing', value: 'Structural Framing' },
				{ name: 'Structural Stiffeners', value: 'Structural Stiffeners' },
				// MEP
				{ name: 'Cable Trays', value: 'Cable Trays' },
				{ name: 'Conduits', value: 'Conduits' },
				{ name: 'Ducts', value: 'Ducts' },
				{ name: 'Electrical Equipment', value: 'Electrical Equipment' },
				{ name: 'Electrical Fixtures', value: 'Electrical Fixtures' },
				{ name: 'Mechanical Equipment', value: 'Mechanical Equipment' },
				{ name: 'Pipes', value: 'Pipes' },
				{ name: 'Plumbing Fixtures', value: 'Plumbing Fixtures' },
				// Furniture / interiors
				{ name: 'Furniture', value: 'Furniture' },
				{ name: 'Furniture Systems', value: 'Furniture Systems' },
				{ name: 'Spaces', value: 'Spaces' },
				{ name: 'Areas', value: 'Areas' },
			],
			default: 'all',
			description: 'Filter elements by Revit category. Pick one category to get a clean table where every row has the same columns.',
		},
		{
			displayName: 'Include Instance Parameters',
			name: 'revitIncludeInstanceParams',
			type: 'boolean',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['extractElementTable'],
					tableSource: ['revit'],
				},
			},
			default: true,
			description: 'Whether to flatten all Revit instance parameters (e.g. Base Constraint, Height, Mark) as columns',
		},
		{
			displayName: 'Include Type Parameters',
			name: 'revitIncludeTypeParams',
			type: 'boolean',
			displayOptions: {
				show: {
					resource: ['object'],
					operation: ['extractElementTable'],
					tableSource: ['revit'],
				},
			},
			default: false,
			description: 'Whether to include type parameters as additional columns (prefixed with "type_")',
		},

		// Return All toggle (Project/Model/Version Get Many only — these are the operations
		// with GraphQL queries that already support cursor-based pagination internally)
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			displayOptions: {
				show: {
					resource: ['project', 'model', 'version'],
					operation: ['getAll'],
				},
			},
			default: false,
			description: 'Whether to return all results by paging through the full list, or only up to the given limit',
		},

		// Limit field
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 100,
				},
				displayOptions: {
					show: {
						operation: ['getAll', 'listBlobs', 'getProjectComments', 'search', 'getActivity'],
					},
					hide: {
						returnAll: [true],
						resource: ['webhook', 'object'],
					},
				},
				default: 20,
				description: 'Max number of results to return',
			},

			// Additional fields
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['get'],
					},
				},
				options: [
					{
						displayName: 'Include Models',
						name: 'includeModels',
						type: 'boolean',
						default: true,
						description: 'Whether to include models in project details',
					},
				],
			},

			// ============================================
			// FETCH GRAPH OPTIONS
			// ============================================
			{
				displayName: 'Options',
				name: 'fetchGraphOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						resource: ['object'],
						operation: ['fetchGraph'],
					},
				},
				options: [
					{
						displayName: 'Max Depth',
						name: 'maxDepth',
						type: 'number',
						default: -1,
						description: 'Maximum depth to traverse (-1 for unlimited)',
					},
					{
						displayName: 'Include Metadata',
						name: 'includeMetadata',
						type: 'boolean',
						default: true,
						description: 'Whether to include Speckle metadata fields',
					},
					{
						displayName: 'Flatten Arrays',
						name: 'flattenArrays',
						type: 'boolean',
						default: false,
						description: 'Whether to flatten array properties',
					},
				],
			},

			// ============================================
			// INPUT FIELDS FOR WRITE OPERATIONS
			// ============================================

			// Project Name (for create/update)
			{
				displayName: 'Project Name',
				name: 'projectName',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['create', 'update'],
					},
				},
				default: '',
				description: 'Name of the project',
			},

			// Project Description (for create/update)
			{
				displayName: 'Project Description',
				name: 'projectDescription',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['create', 'update'],
					},
				},
				default: '',
				description: 'Description of the project. On Update, leave empty to keep the current description.',
			},

			// Project Visibility (for create)
			{
				displayName: 'Visibility',
				name: 'visibility',
				type: 'options',
				options: [
					{
						name: 'Private',
						value: 'PRIVATE',
						description: 'Only team members can access',
					},
					{
						name: 'Public',
						value: 'PUBLIC',
						description: 'Anyone can view',
					},
					{
						name: 'Unlisted',
						value: 'UNLISTED',
						description: 'Anyone with the link can view',
					},
				],
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['create'],
					},
				},
				default: 'PRIVATE',
				description: 'Who can access this project',
			},

			// Project Visibility (for update)
			{
				displayName: 'Visibility',
				name: 'visibility',
				type: 'options',
				options: [
					{
						name: 'Keep Current',
						value: '',
						description: 'Leave the visibility unchanged',
					},
					{
						name: 'Private',
						value: 'PRIVATE',
						description: 'Only team members can access',
					},
					{
						name: 'Public',
						value: 'PUBLIC',
						description: 'Anyone can view',
					},
					{
						name: 'Unlisted',
						value: 'UNLISTED',
						description: 'Anyone with the link can view',
					},
				],
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['update'],
					},
				},
				default: '',
				description: 'Who can access this project. Keep Current leaves it unchanged.',
			},

			// Project Name (for Get By Name)
			{
				displayName: 'Project Name',
				name: 'projectSearchName',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['getByName'],
					},
				},
				default: '',
				description: 'Exact name of the project to find (case-insensitive)',
			},


			// Model Name (for create/update)
			{
				displayName: 'Model Name',
				name: 'modelName',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['model'],
						operation: ['create', 'update'],
					},
				},
				default: '',
				description: 'Name of the model',
			},

			// Model Description (for create/update)
			{
				displayName: 'Model Description',
				name: 'modelDescription',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['model'],
						operation: ['create', 'update'],
					},
				},
				default: '',
				description: 'Description of the model. On Update, leave empty to keep the current description.',
			},

			// Model Name (for Get By Name)
			{
				displayName: 'Model Name',
				name: 'modelSearchName',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['model'],
						operation: ['getByName'],
					},
				},
				default: '',
				description: 'Exact name of the model to find within the project (case-insensitive)',
			},


			// Version/Commit Message (for create)
			{
				displayName: 'Version Message',
				name: 'versionMessage',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['version'],
						operation: ['create'],
					},
				},
				default: '',
				description: 'Commit message for the version',
			},

			// Object ID (for version create)
			{
				displayName: 'Object ID',
				name: 'objectId',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['version'],
						operation: ['create'],
					},
				},
				default: '',
				description: 'The ID of the object to commit',
			},


// Comment Text (for create/reply/edit)
			{
				displayName: 'Comment Text',
				name: 'commentText',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['comment'],
						operation: ['create', 'reply', 'edit'],
					},
				},
				default: '',
				description: 'The content of the comment',
			},

			// Comment ID (for reply/archive/edit/markViewed)
			{
				displayName: 'Comment ID',
				name: 'commentId',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['comment'],
						operation: ['reply', 'archive', 'edit', 'markViewed'],
					},
				},
				default: '',
				description: 'The ID of the comment thread to reply to, archive, edit, or mark as viewed',
			},

			// Archive Status (for archive operation)
			{
				displayName: 'Archived',
				name: 'archived',
				type: 'boolean',
				displayOptions: {
					show: {
						resource: ['comment'],
						operation: ['archive'],
					},
				},
				default: true,
				description: 'Whether to archive (true) or unarchive (false) the comment',
			},

			// Resource ID String (for comment create — new API)
			{
				displayName: 'Resource ID String',
				name: 'resourceIdString',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['comment'],
						operation: ['create'],
					},
				},
				default: '',
				description: 'Viewer resource string linking the comment to a model/version (e.g. "modelId@versionId"). The Speckle API requires a value here; leave empty only if you want to attempt a project-level comment (server behavior for an empty string may vary).',
			},

			// ============================================
			// VERSION MOVE / MARK RECEIVED
			// ============================================

			// Target Model Name (for version.moveToModel)
			{
				displayName: 'Target Model Name',
				name: 'targetModelName',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['version'],
						operation: ['moveToModel'],
					},
				},
				default: '',
				description: 'Name of the destination model. Will be created if it does not exist.',
			},
			// Version IDs to move (for version.moveToModel)
			{
				displayName: 'Version IDs',
				name: 'versionIdsToMove',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['version'],
						operation: ['moveToModel'],
					},
				},
				default: '',
				description: 'Comma-separated list of version IDs to move to the target model',
			},
			// Source Application (for version.markReceived)
			{
				displayName: 'Source Application',
				name: 'sourceApplication',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['version'],
						operation: ['markReceived'],
					},
				},
				default: 'n8n',
				description: 'The name of the application that received this version',
			},
			{
				displayName: 'Message',
				name: 'receivedMessage',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['version'],
						operation: ['markReceived'],
					},
				},
				default: '',
				description: 'Optional message describing how/where it was received',
			},

			// ============================================
			// TOKEN PARAMETERS
			// ============================================
			{
				displayName: 'Token Name',
				name: 'tokenName',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['token'],
						operation: ['create'],
					},
				},
				default: '',
				description: 'The name of the API token',
			},
			{
				displayName: 'Scopes',
				name: 'tokenScopes',
				type: 'multiOptions',
				required: true,
				displayOptions: {
					show: {
						resource: ['token'],
						operation: ['create'],
					},
				},
				options: [
					{ name: 'Read Streams', value: 'streams:read' },
					{ name: 'Write Streams', value: 'streams:write' },
					{ name: 'Read Profile', value: 'profile:read' },
					{ name: 'Write Profile', value: 'profile:write' },
					{ name: 'Read Emails', value: 'emails:read' },
					{ name: 'Read Users', value: 'users:read' },
					{ name: 'Write Invites', value: 'users:invite' },
					{ name: 'Read Server Stats (Admin)', value: 'server:stats' },
					{ name: 'Access Apps', value: 'apps:read' },
					{ name: 'Write Apps', value: 'apps:write' },
					{ name: 'Manage Tokens', value: 'tokens:write' },
				],
				default: ['streams:read'],
				description: 'Permission scopes for this token. To use this operation, the credential configured on the node must already include `tokens:write`.',
			},
			{
				displayName: 'Lifespan (days)',
				name: 'tokenLifespanDays',
				type: 'number',
				displayOptions: {
					show: {
						resource: ['token'],
						operation: ['create'],
					},
				},
				default: 0,
				description: 'Number of days until the token expires. Set to 0 for no expiry.',
			},
			{
				displayName: 'Token',
				name: 'tokenToRevoke',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['token'],
						operation: ['revoke'],
					},
				},
				default: '',
				description: 'The API token string to revoke',
			},

			// Webhook URL
			{
				displayName: 'Webhook URL',
				name: 'webhookUrl',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create'],
					},
				},
				default: '',
				description: 'The URL to send the webhook events to',
			},
			{
				displayName: 'Webhook URL',
				name: 'webhookUrl',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['update'],
					},
				},
				default: '',
				description: 'New URL to send the webhook events to. Leave empty to keep unchanged.',
			},
			{
				displayName: 'Description',
				name: 'webhookDescription',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create', 'update'],
					},
				},
				default: '',
				description: 'Description of the webhook',
			},
			{
				displayName: 'Enabled',
				name: 'webhookEnabled',
				type: 'boolean',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['update'],
					},
				},
				default: true,
				description: 'Whether the webhook is enabled',
			},
			{
				displayName: 'Triggers',
				name: 'webhookTriggers',
				type: 'options',
				typeOptions: {
					multipleValues: true,
				},
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create', 'update'],
					},
				},
				options: [
					{ name: 'Stream Update', value: 'stream_update' },
					{ name: 'Stream Delete', value: 'stream_delete' },
					{ name: 'Branch Create', value: 'branch_create' },
					{ name: 'Branch Update', value: 'branch_update' },
					{ name: 'Branch Delete', value: 'branch_delete' },
					{ name: 'Commit Create', value: 'commit_create' },
					{ name: 'Commit Update', value: 'commit_update' },
					{ name: 'Commit Delete', value: 'commit_delete' },
					{ name: 'Comment Create', value: 'comment_created' },
					{ name: 'Comment Reply', value: 'comment_replied' },
				],
				default: ['commit_create'],
				description: 'Events that trigger the webhook. For Update, this replaces the existing trigger list.',
			},
			{
				displayName: 'Webhook ID',
				name: 'webhookId',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['delete', 'update', 'get', 'test'],
					},
				},
				default: '',
				description: 'The ID of the webhook',
			},

		],
	};

	methods = {
		listSearch: {
			async searchProjects(this: ILoadOptionsFunctions, filter?: string, paginationToken?: string): Promise<INodeListSearchResult> {
				const credentials = await this.getCredentials('speckleApi') as SpeckleCredentials;
				const client = new SpeckleClient(this, credentials, false);
				const data = await client.makeGraphQLRequest(queries.listProjects, {
					limit: 50,
					cursor: paginationToken ?? null,
					filter: filter ? { search: filter } : undefined,
				});
				const page = data?.activeUser?.projects;
				return {
					results: (page?.items ?? []).map((project: any) => ({
						name: project.name,
						value: project.id,
						url: `${credentials.serverUrl}/projects/${project.id}`,
					})),
					paginationToken: page?.cursor ?? undefined,
				};
			},

			async searchModels(this: ILoadOptionsFunctions, filter?: string, paginationToken?: string): Promise<INodeListSearchResult> {
				const projectId = resolveSpeckleId(this.getNodeParameter('projectId', ''), 'project');
				if (!projectId) return { results: [] };

				const credentials = await this.getCredentials('speckleApi') as SpeckleCredentials;
				const client = new SpeckleClient(this, credentials, false);
				const data = await client.makeGraphQLRequest(queries.getModels, {
					projectId,
					limit: 100,
					cursor: paginationToken ?? null,
				});
				const page = data?.project?.models;
				const needle = (filter ?? '').trim().toLowerCase();
				return {
					results: (page?.items ?? [])
						.filter((model: any) => !needle || String(model.name ?? '').toLowerCase().includes(needle))
						.map((model: any) => ({
							name: model.name,
							value: model.id,
							url: `${credentials.serverUrl}/projects/${projectId}/models/${model.id}`,
						})),
					paginationToken: page?.cursor ?? undefined,
				};
			},

			async searchVersions(this: ILoadOptionsFunctions, filter?: string, paginationToken?: string): Promise<INodeListSearchResult> {
				const projectId = resolveSpeckleId(this.getNodeParameter('projectId', ''), 'project');
				if (!projectId) return { results: [] };
				// Model is not shown for every operation that takes a version; fall back to the project's recent versions
				const modelId = resolveSpeckleId(this.getNodeParameter('modelId', ''), 'model');

				const credentials = await this.getCredentials('speckleApi') as SpeckleCredentials;
				const client = new SpeckleClient(this, credentials, false);
				let page: any;
				if (modelId) {
					const data = await client.makeGraphQLRequest(queries.getModelVersions, {
						projectId,
						modelId,
						limit: 50,
						cursor: paginationToken ?? null,
					});
					page = data?.project?.model?.versions;
				} else {
					const data = await client.makeGraphQLRequest(queries.projectActivity, { projectId, limit: 50 });
					page = { items: data?.project?.versions?.items ?? [] };
				}

				const needle = (filter ?? '').trim().toLowerCase();
				return {
					results: (page?.items ?? [])
						.map((version: any) => ({
							name: `${version.message || 'No message'} (${new Date(version.createdAt).toLocaleDateString()}) · ${version.id}`,
							value: version.id,
							url: `${credentials.serverUrl}/projects/${projectId}/models/${version.model?.id ?? modelId}@${version.id}`,
						}))
						.filter((entry: any) => !needle || entry.name.toLowerCase().includes(needle)),
					paginationToken: page?.cursor ?? undefined,
				};
			},
		},
		loadOptions: {
			// Load property paths for the selected object so updateProperties can use a dropdown
			async getObjectPropertyPaths(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const projectId = resolveSpeckleId(this.getNodeParameter('projectId', ''), 'project');
				const objectId = (this.getNodeParameter('objectId') as string) || '';

				if (!projectId || !objectId) {
					return [];
				}

				const credentials = await this.getCredentials('speckleApi') as SpeckleCredentials;
				const client = new SpeckleClient(this as any, credentials, false);

				try {
					const rawObject = await client.fetchObject(projectId, objectId);
					const options: INodePropertyOptions[] = [];
					const seen = new Set<string>();
					const skippedKeys = new Set([
						'displayValue',
						'displayMesh',
						'displayMeshes',
						'renderMaterial',
						'vertices',
						'faces',
						'colors',
						'textureCoordinates',
					]);

					const previewValue = (value: any): string | undefined => {
						if (value === null) return 'null';
						if (value === undefined) return 'undefined';
						if (Array.isArray(value)) return `Array(${value.length})`;
						if (typeof value === 'object') return 'Object';
						const text = String(value);
						return text.length > 80 ? `${text.slice(0, 77)}...` : text;
					};

					const addPath = (path: string, value: any): void => {
						if (!path || seen.has(path)) return;
						seen.add(path);
						options.push({
							name: path,
							value: path,
							description: previewValue(value),
						});
					};

					const walk = (value: any, currentPath = '', depth = 0): void => {
						if (depth > 8) return;

						if (value === null || value === undefined) {
							if (currentPath) addPath(currentPath, value);
							return;
						}

						if (typeof value !== 'object') {
							if (currentPath) addPath(currentPath, value);
							return;
						}

						if (Array.isArray(value)) {
							if (value.length === 0 || value.length > 25) {
								if (currentPath) addPath(currentPath, value);
								return;
							}

							value.forEach((item, index) => {
								walk(item, currentPath ? `${currentPath}.${index}` : String(index), depth + 1);
							});
							return;
						}

						const entries = Object.entries(value as Record<string, any>);
						if (entries.length === 0) {
							if (currentPath) addPath(currentPath, value);
							return;
						}

						for (const [key, childValue] of entries) {
							if (skippedKeys.has(key)) continue;
							const nextPath = currentPath ? `${currentPath}.${key}` : key;

							if (typeof childValue === 'object' && childValue !== null) {
								walk(childValue, nextPath, depth + 1);
							} else {
								addPath(nextPath, childValue);
							}
						}
					};

					walk(rawObject);

					return options.sort((a, b) => a.name.localeCompare(b.name));
				} catch (error) {
					console.error('Failed to load property paths:', error);
					return [];
				}
			},
		},
	};


	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('speckleApi') as SpeckleCredentials;

		// Ensure the loop runs at least once so that operations that need no input
		// (getActivity, getAll, get, etc.) execute even when there are no upstream items.
		const itemCount = items.length || 1;
		for (let i = 0; i < itemCount; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as Resource;
				const operation = this.getNodeParameter('operation', i) as Operation;
				const enableDebug = this.getNodeParameter('enableDebug', i, false) as boolean;
				const client = new SpeckleClient(this, credentials, enableDebug);

				// Reads a Project / Model / Version picker and returns the bare ID
				const getId = (name: string): string => {
					const id = resolveSpeckleId(this.getNodeParameter(name, i), ID_PARAMETER_KINDS[name]);
					if (!id) {
						throw new SpeckleError(this.getNode(), `A required ${ID_PARAMETER_KINDS[name]} is missing (parameter "${name}"). Pick one from the list or enter its ID or URL.`);
					}
					return id;
				};

				let responseData;

				switch (resource) {
					case 'project': {
						if (operation === 'create') {
							const name = this.getNodeParameter('projectName', i) as string;
							const description = this.getNodeParameter('projectDescription', i, '') as string;
							const visibility = this.getNodeParameter('visibility', i, 'PRIVATE') as string;
							const input = { name, description, visibility };
							const response = await client.makeGraphQLRequest(mutations.projectCreate, { input });
							responseData = response.projectMutations.create;
						} else if (operation === 'update') {
							const id = getId('projectId');
							const name = this.getNodeParameter('projectName', i) as string;
							const description = this.getNodeParameter('projectDescription', i, '') as string;
							const visibility = this.getNodeParameter('visibility', i, '') as string;
							// Blank description / "Keep Current" visibility are left out so they are not overwritten
							const update = { id, name, description: description || undefined, visibility: visibility || undefined };
							const response = await client.makeGraphQLRequest(mutations.projectUpdate, { update });
							responseData = response.projectMutations.update;
						} else if (operation === 'delete') {
							const projectId = getId('projectId');
							const response = await client.makeGraphQLRequest(mutations.projectDelete, { projectId });
							responseData = { success: response.projectMutations.delete, deletedProjectId: projectId };
						} else if (operation === 'invite') {
							const projectId = getId('projectId');
							const email = this.getNodeParameter('userEmail', i) as string;
							const role = this.getNodeParameter('userRole', i) as string;
							const response = await client.makeGraphQLRequest(mutations.projectInvite, { projectId, email, role });
							responseData = response.projectMutations.invites.create;
						} else if (operation === 'remove') {
							const projectId = getId('projectId');
							const userId = this.getNodeParameter('targetUserId', i) as string;
							const response = await client.makeGraphQLRequest(mutations.projectRemoveUser, { projectId, userId });
							responseData = { success: true, removedUserId: userId, project: response.projectMutations.updateRole };
						} else if (operation === 'getTeam') {
							const projectId = getId('projectId');
							const response = await client.makeGraphQLRequest(queries.getProjectTeam, { projectId });
							responseData = response.project;
						} else if (operation === 'leave') {
							const projectId = getId('projectId');
							const response = await client.makeGraphQLRequest(mutations.projectLeave, { projectId });
							responseData = { success: response.projectMutations.leave, projectId };
						} else if (operation === 'updateRole') {
							const projectId = getId('projectId');
							const userId = this.getNodeParameter('targetUserId', i) as string;
							const role = this.getNodeParameter('newRole', i) as string;
							const response = await client.makeGraphQLRequest(mutations.projectUpdateRole, {
								projectId,
								userId,
								role: role || null,
							});
							responseData = response.projectMutations.updateRole;
						} else if (operation === 'transfer') {
							const sourceProjectId = getId('projectId');
							const destinationServerUrl = (this.getNodeParameter('destinationServerUrl', i) as string).trim().replace(/\/+$/, '');
							const destinationToken = this.getNodeParameter('destinationToken', i) as string;
							const destinationVisibility = this.getNodeParameter('destinationVisibility', i, 'PRIVATE') as string;
							const destinationProjectId = cleanSpeckleId(this.getNodeParameter('destinationProjectId', i, '') as string);
							const destinationProjectName = this.getNodeParameter('destinationProjectName', i, '') as string;
							const transferVersionMode = this.getNodeParameter('transferVersionMode', i, 'latest') as TransferVersionMode;
							const commitPrefix = this.getNodeParameter('transferCommitPrefix', i, '[Transferred]') as string;

							const sourceProjectResp = await client.makeGraphQLRequest(queries.getProject, { projectId: sourceProjectId, modelLimit: 0 });
							const sourceProject = sourceProjectResp?.project;
							if (!sourceProject) {
								throw new SpeckleError(this.getNode(), `Project not found: ${sourceProjectId}`);
							}

							const targetClient = new SpeckleClient(this, { serverUrl: destinationServerUrl, token: destinationToken }, enableDebug);
							const destinationProject = await ensureDestinationProject(
								targetClient,
								sourceProject,
								destinationProjectId,
								destinationProjectName,
								destinationVisibility,
							);

							const sourceModels = await listProjectModels(client, sourceProjectId);
							const transferredModels: any[] = [];
							const uploadedObjectIdsCache = new Set<string>();

							for (const sourceModel of sourceModels) {
								const destinationModel = await ensureDestinationModel(
									targetClient,
									destinationProject.id,
									sourceModel,
									'',
									'',
								);

								const versions = await listModelVersions(client, sourceProjectId, sourceModel.id, transferVersionMode);
								const transferredVersions: any[] = [];
								for (const sourceVersion of versions) {
									transferredVersions.push(await transferVersionToServer({
										sourceClient: client,
										targetClient,
										sourceProjectId,
										sourceProject,
										sourceModel,
										sourceVersion,
										destinationProjectId: destinationProject.id,
										destinationModelId: destinationModel.id,
										commitPrefix,
										sourceServerUrl: credentials.serverUrl,
										uploadedObjectIdsCache,
									}));
								}

								transferredModels.push({
									sourceModelId: sourceModel.id,
									sourceModelName: sourceModel.name,
									destinationModelId: destinationModel.id,
									destinationModelName: destinationModel.name,
									versionsTransferred: transferredVersions.length,
									transferredVersions,
								});
							}

							responseData = {
								sourceProjectId,
								sourceProjectName: sourceProject.name,
								destinationServerUrl,
								destinationProject,
								versionTransferMode: transferVersionMode,
								modelsTransferred: transferredModels.length,
								transferredModels,
							};
						} else if (operation === 'exportPayload') {
							const sourceProjectId = getId('projectId');
							const transferVersionMode = this.getNodeParameter('transferVersionMode', i, 'latest') as TransferVersionMode;
							const transferPayload = await buildTransferPayload({
								resourceType: 'project',
								sourceClient: client,
								sourceServerUrl: credentials.serverUrl,
								projectId: sourceProjectId,
								versionMode: transferVersionMode,
								node: this,
							});
							responseData = {
								message: 'Project transfer payload exported successfully',
								transferPayload,
								modelsExported: transferPayload.models.length,
								objectsExported: transferPayload.objectStoreCount ?? 0,
							};
						} else if (operation === 'importPayload') {
							const destinationProjectId = cleanSpeckleId(this.getNodeParameter('destinationProjectId', i, '') as string);
							const destinationProjectName = this.getNodeParameter('destinationProjectName', i, '') as string;
							const destinationVisibility = this.getNodeParameter('destinationVisibility', i, 'PRIVATE') as string;
							const commitPrefix = this.getNodeParameter('transferCommitPrefix', i, '[Transferred]') as string;
							responseData = await importTransferPayloadToServer({
								targetClient: client,
								payload: items[i]?.json,
								destinationProjectId,
								destinationProjectName,
								destinationModelId: '',
								destinationModelName: '',
								visibility: destinationVisibility,
								commitPrefix,
								node: this,
							});
						} else {
							const limit = this.getNodeParameter('limit', i, 20) as number;

							if (operation === 'getAll') {
								const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
								if (returnAll) {
									const allProjects: any[] = [];
									let cursor: string | null = null;
									do {
										const response = await client.makeGraphQLRequest(queries.listProjects, { limit: 100, cursor });
										allProjects.push(...(response?.activeUser?.projects?.items ?? []));
										cursor = response?.activeUser?.projects?.cursor ?? null;
									} while (cursor);
									responseData = allProjects;
								} else {
									const response = await client.makeGraphQLRequest(queries.listProjects, { limit });
									responseData = response.activeUser.projects.items;
								}
							} else if (operation === 'getByName') {
								const name = this.getNodeParameter('projectSearchName', i) as string;
								const found = await findProjectByName(client, name);
								if (!found) {
									throw new SpeckleError(this.getNode(), `Project not found with name: ${name}`);
								}
								responseData = found;
							} else if (operation === 'getActivity') {
								const projectId = getId('projectId');
								const response = await client.makeGraphQLRequest(queries.projectActivity, { projectId, limit });
								responseData = response.project?.versions?.items ?? [];
							} else if (operation === 'get') {
								const projectId = getId('projectId');
								const additionalFields = this.getNodeParameter('additionalFields', i, {}) as { includeModels?: boolean };
								const modelLimit = additionalFields.includeModels !== false ? 20 : 0;
								const response = await client.makeGraphQLRequest(queries.getProject, { projectId, modelLimit });
								responseData = response.project;
							} else if (operation === 'search') {
								const searchQuery = this.getNodeParameter('query', i) as string;
								const response = await client.makeGraphQLRequest(queries.listProjects, {
									limit,
									filter: { search: searchQuery },
								});
								responseData = response.activeUser.projects.items;
							} else if (operation === 'importFile') {
								const projectId = getId('projectId');
								const modelId = getId('modelId');
								const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
								const items = this.getInputData();
								const binaryDataContainer = items[i].binary;

								if (!binaryDataContainer || !binaryDataContainer[binaryPropertyName]) {
									throw new SpeckleError(this.getNode(), `Binary data property '${binaryPropertyName}' does not exist on item ${i}`);
								}

								const binaryData = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
								const binaryMetadata = items[i].binary![binaryPropertyName];
								const fileName = binaryMetadata?.fileName || 'upload.ifc';


								// 1. Generate Upload URL
								const uploadResp = await client.makeGraphQLRequest(mutations.generateUploadUrl, {
									projectId,
									fileName
								});
								const { url: uploadUrl, fileId } = uploadResp.fileUploadMutations.generateUploadUrl;

								// 2. Upload File (PUT)
								// Note: We use axios directly here because we need to send raw binary buffer with correct content type
								const putResponse = await axios.put(uploadUrl, binaryData, {
									headers: {
										'Content-Type': 'application/octet-stream',
									},
									maxBodyLength: Infinity,
									maxContentLength: Infinity
								});

								// Capture ETag from response headers (normalized to lowercase 'etag')
								const etag = putResponse.headers['etag'] || putResponse.headers['ETag'];

								if (!etag) {
									throw new SpeckleError(this.getNode(), 'Failed to retrieve ETag from file upload response');
								}

								// 3. Trigger Import
								const importResp = await client.makeGraphQLRequest(mutations.startFileImport, {
									projectId,
									modelId,
									fileId,
									etag
								});

								responseData = {
									success: importResp.fileUploadMutations.startFileImport,
									fileId,
									fileName,
									message: 'File uploaded and import started'
								};
							} else if (operation === 'downloadFile') {
								const projectId = getId('projectId');
								const blobId = this.getNodeParameter('blobId', i) as string;

								const baseUrl = credentials.serverUrl.replace(/\/$/, '');

								// 1. Try to verify/fetch metadata via GraphQL
								let blobMetadata = null;
								try {
									const gqlResponse = await client.makeGraphQLRequest(queries.getBlobMetadata, { projectId, blobId });
									if (gqlResponse.project?.blob) {
										blobMetadata = gqlResponse.project.blob;
									}
								} catch (e) {
									// Ignore GraphQL errors, proceed to REST
								}

								// 2. Try multiple potential REST endpoints
								const candidatePaths = [
									`/api/streams/${projectId}/blobs/${blobId}`, // v2 standard
									`/api/streams/${projectId}/blob/${blobId}`,  // v2 variant
									`/api/stream/${projectId}/blob/${blobId}`,   // v1/legacy
									`/api/stream/${projectId}/blobs/${blobId}`,  // variant
									`/api/getblob/${blobId}`,                    // community hint
									`/blobs/${blobId}`,                          // global
								];

								let blobResponse;
								let blobLastError;
								let successUrl = '';

								for (const blobPath of candidatePaths) {
									const blobUrl = `${baseUrl}${blobPath}`;
									try {
										blobResponse = await axios.get(blobUrl, {
											headers: { 'Authorization': `Bearer ${credentials.token}` },
											responseType: 'arraybuffer',
										});
										successUrl = blobUrl;
										break;
									} catch (error) {
										blobLastError = error;
									}
								}

								if (!blobResponse) {
									const errorMessage = blobLastError instanceof Error ? blobLastError.message : 'Unknown error';
									let msg = `Failed to download blob. Tried multiple endpoints (e.g. ${candidatePaths[0]}). Last error: ${errorMessage}`;
									if (blobMetadata) {
										msg += `. Note: Blob WAS found via GraphQL (Name: ${blobMetadata.fileName}), but download routes failed.`;
									}
									throw new SpeckleError(this.getNode(), msg);
								}

								const contentDisposition = (blobResponse as any).headers['content-disposition'];
								let fileName = blobMetadata?.fileName || 'downloaded_file';
								if (contentDisposition) {
									const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
									if (filenameMatch && filenameMatch.length > 1) {
										fileName = filenameMatch[1];
									}
								}

								const binaryData = await this.helpers.prepareBinaryData(
									Buffer.from((blobResponse as any).data),
									fileName,
								);

								// Binary must be pushed directly — returnJsonArray strips the binary sibling
								returnData.push({
									json: {
										blobId,
										fileName,
										message: 'File downloaded successfully',
										sourceUrl: successUrl,
										metadata: blobMetadata,
									},
									binary: { data: binaryData },
									pairedItem: { item: i },
								});
								responseData = [];

							} else if (operation === 'listBlobs') {
								const projectId = getId('projectId');
								const limit = this.getNodeParameter('limit', i, 20) as number;
								const response = await client.makeGraphQLRequest(queries.projectBlobs, { projectId, limit });
								responseData = response.project.blobs.items;
							}
						}
						break;
					}
					case 'webhook': {
						if (operation === 'create') {
							const projectId = getId('projectId');
							const url = this.getNodeParameter('webhookUrl', i) as string;
							const description = this.getNodeParameter('webhookDescription', i, '') as string;
							const triggers = this.getNodeParameter('webhookTriggers', i) as string[];

							const response = await client.makeGraphQLRequest(mutations.webhookCreate, {
								streamId: projectId,
								url,
								description,
								triggers
							});
							responseData = { webhookId: response.webhookCreate };
						} else if (operation === 'update') {
							const projectId = getId('projectId');
							const webhookId = this.getNodeParameter('webhookId', i) as string;
							const url = this.getNodeParameter('webhookUrl', i, '') as string;
							const description = this.getNodeParameter('webhookDescription', i, '') as string;
							const enabled = this.getNodeParameter('webhookEnabled', i, true) as boolean;
							const triggers = this.getNodeParameter('webhookTriggers', i, []) as string[];

							const response = await client.makeGraphQLRequest(mutations.webhookUpdate, {
								streamId: projectId,
								webhookId,
								url: url || undefined,
								description: description || undefined,
								enabled,
								triggers: triggers.length ? triggers : undefined,
							});
							responseData = { success: response.webhookUpdate, webhookId };
						} else if (operation === 'delete') {
							const projectId = getId('projectId');
							const webhookId = this.getNodeParameter('webhookId', i) as string;

							const response = await client.makeGraphQLRequest(mutations.webhookDelete, {
								streamId: projectId,
								webhookId
							});
							responseData = { success: response.webhookDelete, webhookId };
						} else if (operation === 'get') {
							const projectId = getId('projectId');
							const webhookId = this.getNodeParameter('webhookId', i) as string;
							const response = await client.makeGraphQLRequest(queries.projectWebhook, {
								projectId,
								webhookId,
							});
							responseData = response.project.webhooks.items[0] ?? null;
						} else if (operation === 'getAll') {
							const projectId = getId('projectId');
							const response = await client.makeGraphQLRequest(queries.projectWebhooks, {
								projectId
							});
							responseData = response.project.webhooks.items;
						} else if (operation === 'test') {
							const projectId = getId('projectId');
							const webhookId = this.getNodeParameter('webhookId', i) as string;

							const webhookResp = await client.makeGraphQLRequest(queries.projectWebhook, {
								projectId,
								webhookId,
							});
							const webhookRecord = webhookResp?.project?.webhooks?.items?.[0];
							if (!webhookRecord) {
								throw new SpeckleError(this.getNode(), `Webhook not found: ${webhookId}`);
							}

							const testPayload = {
								streamId: projectId,
								webhookId,
								event: {
									event_name: 'test_event',
									data: {
										message: 'Synthetic test payload sent from the n8n Speckle node to verify webhook connectivity. It does not represent a real Speckle event.',
										triggeredAt: new Date().toISOString(),
									},
								},
							};

							try {
								const testResponse = await axios.post(webhookRecord.url, testPayload, {
									headers: { 'Content-Type': 'application/json' },
									timeout: 15000,
									validateStatus: () => true,
								});
								responseData = {
									webhookId,
									url: webhookRecord.url,
									success: testResponse.status >= 200 && testResponse.status < 300,
									statusCode: testResponse.status,
									responseBody: testResponse.data,
									sentPayload: testPayload,
								};
							} catch (error: any) {
								responseData = {
									webhookId,
									url: webhookRecord.url,
									success: false,
									error: error?.message || 'Request to webhook URL failed',
									sentPayload: testPayload,
								};
							}
						}
						break;
					}
					case 'viewer': {
						const projectId = getId('projectId');
						const modelId = getId('modelId');
						const versionId = getId('versionId');
						const embedUrl = `${credentials.serverUrl}/projects/${projectId}/models/${modelId}@${versionId}#embed=true`;

						responseData = {
							url: embedUrl,
							iframe: `<iframe src="${embedUrl}" width="100%" height="600" frameborder="0" allowfullscreen></iframe>`,
						};
						break;
					}
					case 'model': {
						// importPayload targets the destination project fields instead, so Project ID is not shown for it
						const projectId = operation === 'importPayload' ? '' : getId('projectId');

						if (operation === 'create') {
							const name = this.getNodeParameter('modelName', i) as string;
							const description = this.getNodeParameter('modelDescription', i, '') as string;
							const response = await client.makeGraphQLRequest(mutations.modelCreate, { projectId, name, description });
							responseData = response.modelMutations.create;
						} else if (operation === 'update') {
							const modelId = getId('modelId');
							const name = this.getNodeParameter('modelName', i) as string;
							const description = this.getNodeParameter('modelDescription', i, '') as string;
							const response = await client.makeGraphQLRequest(mutations.modelUpdate, { id: modelId, projectId, name, description: description || undefined });
							responseData = response.modelMutations.update;
						} else if (operation === 'delete') {
							const modelId = getId('modelId');
							const response = await client.makeGraphQLRequest(mutations.modelDelete, { id: modelId, projectId });
							responseData = { success: response.modelMutations.delete, deletedModelId: modelId };
						} else if (operation === 'get') {
							const modelId = getId('modelId');
							const response = await client.makeGraphQLRequest(queries.getModel, { projectId, modelId });
							responseData = response.project?.model;
						} else if (operation === 'getAll') {
							const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
							if (returnAll) {
								responseData = await listProjectModels(client, projectId);
							} else {
								const limit = this.getNodeParameter('limit', i, 20) as number;
								const response = await client.makeGraphQLRequest(queries.getProject, { projectId, modelLimit: limit });
								responseData = response.project?.models?.items;
							}
						} else if (operation === 'getByName') {
							const name = this.getNodeParameter('modelSearchName', i) as string;
							const found = await findModelByName(client, projectId, name);
							if (!found) {
								throw new SpeckleError(this.getNode(), `Model not found with name: ${name} in project ${projectId}`);
							}
							responseData = found;
						} else if (operation === 'transfer') {
							const modelId = getId('modelId');
							const destinationServerUrl = (this.getNodeParameter('destinationServerUrl', i) as string).trim().replace(/\/+$/, '');
							const destinationToken = this.getNodeParameter('destinationToken', i) as string;
							const destinationVisibility = this.getNodeParameter('destinationVisibility', i, 'PRIVATE') as string;
							const destinationProjectId = cleanSpeckleId(this.getNodeParameter('destinationProjectId', i, '') as string);
							const destinationProjectName = this.getNodeParameter('destinationProjectName', i, '') as string;
							const destinationModelId = cleanSpeckleId(this.getNodeParameter('destinationModelId', i, '') as string);
							const destinationModelName = this.getNodeParameter('destinationModelName', i, '') as string;
							const transferVersionMode = this.getNodeParameter('transferVersionMode', i, 'latest') as TransferVersionMode;
							const commitPrefix = this.getNodeParameter('transferCommitPrefix', i, '[Transferred]') as string;

							const sourceProjectResp = await client.makeGraphQLRequest(queries.getProject, { projectId, modelLimit: 0 });
							const sourceProject = sourceProjectResp?.project;
							const sourceModelResp = await client.makeGraphQLRequest(queries.getModel, { projectId, modelId });
							const sourceModel = sourceModelResp?.project?.model;
							if (!sourceProject || !sourceModel) {
								throw new SpeckleError(this.getNode(), `Could not find project/model for transfer (${projectId}/${modelId})`);
							}

							const targetClient = new SpeckleClient(this, { serverUrl: destinationServerUrl, token: destinationToken }, enableDebug);
							const destinationProject = await ensureDestinationProject(
								targetClient,
								sourceProject,
								destinationProjectId,
								destinationProjectName,
								destinationVisibility,
							);
							const destinationModel = await ensureDestinationModel(
								targetClient,
								destinationProject.id,
								sourceModel,
								destinationModelId,
								destinationModelName,
							);

							const versions = await listModelVersions(client, projectId, modelId, transferVersionMode);
							const transferredVersions: any[] = [];
							const uploadedObjectIdsCache = new Set<string>();
							for (const sourceVersion of versions) {
								transferredVersions.push(await transferVersionToServer({
									sourceClient: client,
									targetClient,
									sourceProjectId: projectId,
									sourceProject,
									sourceModel,
									sourceVersion,
									destinationProjectId: destinationProject.id,
									destinationModelId: destinationModel.id,
									commitPrefix,
									sourceServerUrl: credentials.serverUrl,
									uploadedObjectIdsCache,
								}));
							}

							responseData = {
								sourceProjectId: projectId,
								sourceModelId: modelId,
								sourceModelName: sourceModel.name,
								destinationServerUrl,
								destinationProject,
								destinationModel,
								versionTransferMode: transferVersionMode,
								versionsTransferred: transferredVersions.length,
								transferredVersions,
							};
						} else if (operation === 'exportPayload') {
							const modelId = getId('modelId');
							const transferVersionMode = this.getNodeParameter('transferVersionMode', i, 'latest') as TransferVersionMode;
							const transferPayload = await buildTransferPayload({
								resourceType: 'model',
								sourceClient: client,
								sourceServerUrl: credentials.serverUrl,
								projectId,
								modelId,
								versionMode: transferVersionMode,
								node: this,
							});
							responseData = {
								message: 'Model transfer payload exported successfully',
								transferPayload,
								modelsExported: transferPayload.models.length,
								objectsExported: transferPayload.objectStoreCount ?? 0,
							};
						} else if (operation === 'importPayload') {
							const destinationProjectId = cleanSpeckleId(this.getNodeParameter('destinationProjectId', i, '') as string);
							const destinationProjectName = this.getNodeParameter('destinationProjectName', i, '') as string;
							const destinationModelId = cleanSpeckleId(this.getNodeParameter('destinationModelId', i, '') as string);
							const destinationModelName = this.getNodeParameter('destinationModelName', i, '') as string;
							const destinationVisibility = this.getNodeParameter('destinationVisibility', i, 'PRIVATE') as string;
							const commitPrefix = this.getNodeParameter('transferCommitPrefix', i, '[Transferred]') as string;
							responseData = await importTransferPayloadToServer({
								targetClient: client,
								payload: items[i]?.json,
								destinationProjectId,
								destinationProjectName,
								destinationModelId,
								destinationModelName,
								visibility: destinationVisibility,
								commitPrefix,
								node: this,
							});
						}
						break;
					}
					case 'version': {
						// Sanitize Project ID (in case user pasted a URL)
						// importPayload targets the destination project fields instead, so Project ID is not shown for it
						const rawProjectId = operation === 'importPayload' ? '' : getId('projectId');
						const projectId = cleanSpeckleId(rawProjectId);

						if (operation === 'create') {
							const modelId = getId('modelId');
							const objectId = this.getNodeParameter('objectId', i) as string;
							const message = this.getNodeParameter('versionMessage', i, '') as string;
							const response = await client.makeGraphQLRequest(mutations.versionCreate, { projectId, modelId, objectId, message });
							responseData = response.versionMutations.create;
						} else if (operation === 'getAll') {
							const modelId = getId('modelId');
							const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
							if (returnAll) {
								responseData = await listModelVersions(client, projectId, modelId, 'all');
							} else {
								const limit = this.getNodeParameter('limit', i, 20) as number;
								const response = await client.makeGraphQLRequest(queries.getModelVersions, {
									projectId,
									modelId,
									limit
								});
								responseData = response.project.model.versions.items;
							}
						} else if (operation === 'update') {
							const versionId = getId('versionId');
							const message = this.getNodeParameter('versionMessage', i, '') as string;
							const response = await client.makeGraphQLRequest(mutations.versionUpdate, { projectId, versionId, message });
							responseData = response.versionMutations.update;
						} else if (operation === 'delete') {
							const versionId = getId('versionId');
							const response = await client.makeGraphQLRequest(mutations.versionDelete, { projectId, versionIds: [versionId] });
							responseData = { success: response.versionMutations.delete, deletedVersionId: versionId };
						} else if (operation === 'get') {
							const modelId = getId('modelId');
							const versionId = getId('versionId');
							// Using getVersionObjects which returns version metadata + referenced object ID
							const response = await client.makeGraphQLRequest(queries.getVersionObjects, { projectId, modelId, versionId });
							responseData = response.project?.model?.version;
						} else if (operation === 'diff') {
							const rawModelId = getId('modelId');
							const modelId = cleanSpeckleId(rawModelId);
							const rawVersionAId = getId('versionAId');
							const versionAId = cleanSpeckleId(rawVersionAId);
							const rawVersionBId = getId('versionBId');
							const versionBId = cleanSpeckleId(rawVersionBId);

							try {
								// 1) Get referenced object for Version A
								const respA = await client.makeGraphQLRequest(queries.getVersionObjects, { projectId, modelId, versionId: versionAId });
								const refObjA = respA?.project?.model?.version?.referencedObject;
								if (!refObjA) throw new SpeckleError(this.getNode(), `Referenced object not found for Version A (${versionAId})`);

								// 2) Get referenced object for Version B
								const respB = await client.makeGraphQLRequest(queries.getVersionObjects, { projectId, modelId, versionId: versionBId });
								const refObjB = respB?.project?.model?.version?.referencedObject;
								if (!refObjB) throw new SpeckleError(this.getNode(), `Referenced object not found for Version B (${versionBId})`);

								// 3) Perform Paginated Diff (optimized for large models)
								// This fetches metadata in chunks rather than loading entire object trees
								const detailedDiff = this.getNodeParameter('detailedDiff', i, false) as boolean;
								const { diffObjectsPaginated } = await import('./diffHelper');
								responseData = await diffObjectsPaginated(client, projectId, refObjA, refObjB, 500, detailedDiff);
							} catch (error: any) {
								// Improve validation error messages
								if (error instanceof SpeckleError) throw error;
								
								const msg = error.message || '';
								if (msg.includes('Project not found') || msg.includes('STREAM_NOT_FOUND')) {
									throw new SpeckleError(this.getNode(), `Project not found. Please check the Project ID: ${projectId}. If you pasted a URL, ensure it is accessible.`);
								}
								throw error;
							}
						} else if (operation === 'moveToModel') {
							const rawVersionIds = this.getNodeParameter('versionIdsToMove', i) as string;
							const versionIds = rawVersionIds.split(',').map((s: string) => s.trim()).filter(Boolean);
							const targetModelName = this.getNodeParameter('targetModelName', i) as string;
							const response = await client.makeGraphQLRequest(mutations.versionMoveToModel, {
								projectId,
								targetModelName,
								versionIds,
							});
							responseData = response.versionMutations.moveToModel;
						} else if (operation === 'markReceived') {
							const versionId = getId('versionId');
							const sourceApplication = this.getNodeParameter('sourceApplication', i) as string;
							const message = this.getNodeParameter('receivedMessage', i, '') as string;
							const response = await client.makeGraphQLRequest(mutations.versionMarkReceived, {
								projectId,
								versionId,
								sourceApplication,
								message: message || undefined,
							});
							responseData = { success: response.versionMutations.markReceived, versionId, sourceApplication };
						} else if (operation === 'transfer') {
							const modelId = getId('modelId');
							const versionId = getId('versionId');
							const destinationServerUrl = (this.getNodeParameter('destinationServerUrl', i) as string).trim().replace(/\/+$/, '');
							const destinationToken = this.getNodeParameter('destinationToken', i) as string;
							const destinationVisibility = this.getNodeParameter('destinationVisibility', i, 'PRIVATE') as string;
							const destinationProjectId = cleanSpeckleId(this.getNodeParameter('destinationProjectId', i, '') as string);
							const destinationProjectName = this.getNodeParameter('destinationProjectName', i, '') as string;
							const destinationModelId = cleanSpeckleId(this.getNodeParameter('destinationModelId', i, '') as string);
							const destinationModelName = this.getNodeParameter('destinationModelName', i, '') as string;
							const commitPrefix = this.getNodeParameter('transferCommitPrefix', i, '[Transferred]') as string;

							const sourceProjectResp = await client.makeGraphQLRequest(queries.getProject, { projectId, modelLimit: 0 });
							const sourceProject = sourceProjectResp?.project;
							const sourceModelResp = await client.makeGraphQLRequest(queries.getModel, { projectId, modelId });
							const sourceModel = sourceModelResp?.project?.model;
							const sourceVersionResp = await client.makeGraphQLRequest(queries.getVersionObjects, { projectId, modelId, versionId });
							const sourceVersion = sourceVersionResp?.project?.model?.version;
							if (!sourceProject || !sourceModel || !sourceVersion) {
								throw new SpeckleError(this.getNode(), `Could not find project/model/version for transfer (${projectId}/${modelId}/${versionId})`);
							}

							const targetClient = new SpeckleClient(this, { serverUrl: destinationServerUrl, token: destinationToken }, enableDebug);
							const destinationProject = await ensureDestinationProject(
								targetClient,
								sourceProject,
								destinationProjectId,
								destinationProjectName,
								destinationVisibility,
							);
							const destinationModel = await ensureDestinationModel(
								targetClient,
								destinationProject.id,
								sourceModel,
								destinationModelId,
								destinationModelName,
							);

							const transferResult = await transferVersionToServer({
								sourceClient: client,
								targetClient,
								sourceProjectId: projectId,
								sourceProject,
								sourceModel,
								sourceVersion,
								destinationProjectId: destinationProject.id,
								destinationModelId: destinationModel.id,
								commitPrefix,
								sourceServerUrl: credentials.serverUrl,
								uploadedObjectIdsCache: new Set<string>(),
							});

							responseData = {
								sourceProjectId: projectId,
								sourceModelId: modelId,
								sourceVersionId: versionId,
								destinationServerUrl,
								destinationProject,
								destinationModel,
								...transferResult,
							};
						} else if (operation === 'exportPayload') {
							const modelId = getId('modelId');
							const versionId = getId('versionId');
							const transferPayload = await buildTransferPayload({
								resourceType: 'version',
								sourceClient: client,
								sourceServerUrl: credentials.serverUrl,
								projectId,
								modelId,
								versionId,
								versionMode: 'latest',
								node: this,
							});
							responseData = {
								message: 'Version transfer payload exported successfully',
								transferPayload,
								versionsExported: transferPayload.models?.[0]?.versions?.length ?? 0,
							};
						} else if (operation === 'importPayload') {
							const destinationProjectId = cleanSpeckleId(this.getNodeParameter('destinationProjectId', i, '') as string);
							const destinationProjectName = this.getNodeParameter('destinationProjectName', i, '') as string;
							const destinationModelId = cleanSpeckleId(this.getNodeParameter('destinationModelId', i, '') as string);
							const destinationModelName = this.getNodeParameter('destinationModelName', i, '') as string;
							const destinationVisibility = this.getNodeParameter('destinationVisibility', i, 'PRIVATE') as string;
							const commitPrefix = this.getNodeParameter('transferCommitPrefix', i, '[Transferred]') as string;
							responseData = await importTransferPayloadToServer({
								targetClient: client,
								payload: items[i]?.json,
								destinationProjectId,
								destinationProjectName,
								destinationModelId,
								destinationModelName,
								visibility: destinationVisibility,
								commitPrefix,
								node: this,
							});
						}
						break;
					}
					case 'object': {
						// validateIds works on the input items only; create / fetchGraph / validateProperties address an object directly
						const projectId = operation !== 'validateIds' ? getId('projectId') : '';
						const needsVersion = OBJECT_VERSION_OPERATIONS.includes(operation);
						const modelId = needsVersion ? getId('modelId') : '';
						const versionId = needsVersion ? getId('versionId') : '';

						if (operation === 'create') {
							const rawObjectData = this.getNodeParameter('objectData', i) as any;
							let objectData: Record<string, any>;
							if (typeof rawObjectData === 'string') {
								try {
									objectData = JSON.parse(rawObjectData);
								} catch (err: any) {
									throw new SpeckleError(this.getNode(), `Object Data must be valid JSON: ${err.message}`);
								}
							} else {
								objectData = { ...rawObjectData };
							}

							if (!objectData || typeof objectData !== 'object' || Array.isArray(objectData)) {
								throw new SpeckleError(this.getNode(), 'Object Data must be a JSON object, e.g. { "name": "My Object", "value": 42 }');
							}

							if (!objectData.speckle_type && !objectData.speckleType) {
								objectData.speckle_type = 'Base';
							}

							// Compute the object ID the same way Speckle does: MD5 of the JSON with
							// sorted keys, excluding `id` and any `__`-prefixed fields.
							const objForHashing: Record<string, any> = {};
							for (const k of Object.keys(objectData).sort()) {
								if (k !== 'id' && !k.startsWith('__')) objForHashing[k] = objectData[k];
							}
							const newObjectId = crypto.createHash('md5').update(JSON.stringify(objForHashing)).digest('hex');
							objectData.id = newObjectId;

							await client.uploadObjects(projectId, [objectData]);

							const createResult: any = {
								objectId: newObjectId,
								projectId,
							};

							const createVersion = this.getNodeParameter('createVersion', i, false) as boolean;
							if (createVersion) {
								const versionModelId = getId('objectVersionModelId');
								const message = this.getNodeParameter('objectVersionMessage', i, '') as string;
								const versionResponse = await client.makeGraphQLRequest(mutations.versionCreate, {
									projectId,
									modelId: versionModelId,
									objectId: newObjectId,
									message,
								});
								createResult.version = versionResponse.versionMutations.create;
							}

							responseData = createResult;
						} else if (operation === 'getAll') {
							const elementOutput = this.getNodeParameter('elementOutput', i, 'summary') as string;
							const maxElements = this.getNodeParameter('maxElements', i, 0) as number;
							const batchSize = this.getNodeParameter('batchSize', i, 500) as number;

							const versionResp = await client.makeGraphQLRequest(queries.getVersionObjects, { projectId, modelId, versionId });
							const referencedObjectId = versionResp?.project?.model?.version?.referencedObject;
							const detectedSourceApplication = versionResp?.project?.model?.version?.sourceApplication;
							if (!referencedObjectId) {
								throw new SpeckleError(this.getNode(), 'Referenced object not found for the provided version');
							}

							// Flattened-output options (ignored by the other output shapes)
							const includeGeometry = this.getNodeParameter('includeGeometry', i, false) as boolean;
							const flattenNested = this.getNodeParameter('flattenNested', i, true) as boolean;
							const propertyPrefix = this.getNodeParameter('propertyPrefix', i, 'none') as string;
							const applicationHint = this.getNodeParameter('applicationHint', i, 'auto') as string;
							const sourceApplication = applicationHint !== 'auto' ? applicationHint : detectedSourceApplication;

							const rows: any[] = [];
							let cursor: string | null = null;
							let limitReached = false;

							do {
								const page = await client.getObjectMetadata(projectId, referencedObjectId, batchSize, cursor);
								cursor = page.cursor;

								for (const obj of page.objects ?? []) {
									if (elementOutput === 'raw') {
										rows.push(obj);
									} else if (!isRealBIMElement(obj)) {
										continue;
									} else if (elementOutput === 'flat') {
										rows.push(extractMetadataFromObject(obj, sourceApplication, includeGeometry, flattenNested, propertyPrefix));
									} else {
										rows.push(summariseElement(obj, detectedSourceApplication));
									}

									if (maxElements > 0 && rows.length >= maxElements) {
										limitReached = true;
										break;
									}
								}
							} while (cursor && !limitReached);

							responseData = rows;
						} else if (operation === 'filterObjects') {
				// Build propertyQuery from user-friendly parameters
				const propertyToSearch = this.getNodeParameter('propertyToSearch', i) as string;
				const matchType = this.getNodeParameter('matchType', i) as string;
				const filterOutput = this.getNodeParameter('filterOutput', i, 'objects') as string;
				const maxNodesToInspect = this.getNodeParameter('maxNodesToInspect', i, 1000) as number;

				// Determine the actual property name
				let propertyName: string;
				if (propertyToSearch === 'custom') {
					propertyName = this.getNodeParameter('customPropertyName', i) as string;
					if (!propertyName || propertyName.trim() === '') {
						throw new SpeckleError(this.getNode(), 'Custom Property Name must be provided when "Custom Property" is selected');
					}
				} else {
					propertyName = propertyToSearch;
				}

				// Get search value if needed
				let searchValue = '';
				if (matchType === 'contains' || matchType === 'equals') {
					searchValue = this.getNodeParameter('searchValue', i, '') as string;
					if (!searchValue || searchValue.trim() === '') {
						throw new SpeckleError(this.getNode(), 'Search Value must be provided for "Contains Value" or "Equals Value" match types');
					}
				}

				// Build the query string (for internal use)
				const propertyQuery = searchValue ? `${propertyName}:${searchValue}` : propertyName;

				if (!propertyQuery || propertyQuery.trim() === '') {
					throw new SpeckleError(this.getNode(), 'Property search criteria must be provided');
				}
							// 1) Get referenced object id from version
							const versionResp = await client.makeGraphQLRequest(queries.getVersionObjects, { projectId, modelId, versionId });
							const referencedObjectId = versionResp?.project?.model?.version?.referencedObject;
							const sourceApplication = versionResp?.project?.model?.version?.sourceApplication;
							if (!referencedObjectId) {
								throw new SpeckleError(this.getNode(), 'Referenced object not found for the provided version');
							}

							// 2) Fetch ALL object metadata (like Get Metadata does)
							// This gets the actual BIM elements, not just the root object
							console.log(`[${operation}] Fetching object metadata for filtering...`);
							const allObjects: any[] = [];
							let cursor: string | null = null;
							const pageSize = 500;
							let totalFetched = 0;

							do {
								const result = await client.getObjectMetadata(
									projectId,
									referencedObjectId,
									pageSize,
									cursor
								);

								if (result.objects && result.objects.length > 0) {
									allObjects.push(...result.objects);
									totalFetched += result.objects.length;
								}

								cursor = result.cursor;
								
								// Stop if we've fetched enough objects for filtering
								if (totalFetched >= maxNodesToInspect) {
									console.log(`[${operation}] Reached maxNodesToInspect limit (${maxNodesToInspect}), stopping fetch`);
									break;
								}
							} while (cursor);

							console.log(`[${operation}] Fetched ${allObjects.length} objects, now filtering...`);

							// 3) Parse query: key:value or key
							const [rawKey, ...rest] = propertyQuery.split(':');
							const key = rawKey.trim();
							const value = rest.length ? rest.join(':').trim() : undefined;

							// 4) Helper to get nested value by dot-path
							const getValueByPath = (obj: any, p: string): any => {
								if (obj == null) return undefined;
								const parts = p.split('.').filter(Boolean);
								let cur: any = obj;
								for (const part of parts) {
									if (cur == null) return undefined;
									// numeric index support
									if (/^\d+$/.test(part)) {
										const idx = Number(part);
										if (!Array.isArray(cur)) return undefined;
										cur = cur[idx];
									} else {
										cur = cur[part];
									}
								}
								return cur;
							};

							// 5) Filter objects based on property query
							//
							// Note: the metadata query's server-side field selection returns every
							// requested top-level field on every object, using `null` (not an absent key)
							// for fields that don't apply to that object — e.g. a Revit object explicitly
							// has `speckleType: null` alongside a real `speckle_type` value. So each
							// fallback below must treat `null` the same as `undefined` ("no value yet,
							// keep looking"), not just check `=== undefined`.
							const isEmpty = (x: any): boolean => x === undefined || x === null;
							const matches: any[] = [];
							for (const obj of allObjects) {
								// Check top-level properties
								let v = getValueByPath(obj, key);

								// Also check inside properties object (old schema: e.g. "family" nested under properties)
								if (isEmpty(v) && obj.properties) {
									v = getValueByPath(obj.properties, key);
								}

								// New DataObject schema promoted family/type/level/ifcType etc. to top-level
								// siblings of speckleType. Preset dropdown values like "properties.family" would
								// otherwise never match those objects, so strip a leading "properties." and
								// re-check the top level.
								if (isEmpty(v) && key.startsWith('properties.')) {
									v = getValueByPath(obj, key.slice('properties.'.length));
								}

								// speckleType/speckle_type is a well-known dual-cased alias — the metadata
								// query can return either depending on server/connector, so check both ways.
								if (isEmpty(v) && key === 'speckleType') {
									v = getValueByPath(obj, 'speckle_type');
								} else if (isEmpty(v) && key === 'speckle_type') {
									v = getValueByPath(obj, 'speckleType');
								}

								// Check if match found
				if (!isEmpty(v)) {
					if (value === undefined) {
						// Presence match (matchType === 'exists')
						matches.push({
							objectId: obj.id,
							matchedKey: key,
							matchedValue: v,
							object: obj,
						});
					} else {
						const s = String(v).toLowerCase();
						const searchLower = value.toLowerCase();
						
						// Check match based on matchType
						let isMatch = false;
						if (matchType === 'equals') {
							isMatch = s === searchLower;
						} else {
							// Default to 'contains'
							isMatch = s.includes(searchLower);
						}
						
						if (isMatch) {
							matches.push({
								objectId: obj.id,
								matchedKey: key,
								matchedValue: v,
								object: obj,
							});
						}
					}
				}
							}

							console.log(`[${operation}] Searched ${allObjects.length} objects, found ${matches.length} matches`);

							if (filterOutput === 'summary') {
								responseData = {
									versionId,
									referencedObjectId,
									sourceApplication,
									totalObjects: allObjects.length,
									matches: matches.map(m => ({
										objectId: m.objectId,
										matchedKey: m.matchedKey,
										matchedValue: m.matchedValue,
										speckleType: m.object.speckleType || m.object.speckle_type,
										category: m.object.category
									})),
									note: `Searched ${allObjects.length} objects from version metadata. Set Output to Matching Objects to get full object data.`,
								};
							} else {
								// Return full matched objects
								responseData = matches.map(match => match.object);
								console.log(`[filterObjects] Returning ${responseData.length} objects`);
							}
						} else if (operation === 'validateProperties') {
							const objectId = this.getNodeParameter('objectId', i) as string;
							const validationMode = this.getNodeParameter('validationMode', i, 'all') as string;
							const validationRulesParam = this.getNodeParameter('validationRules', i, { rules: [] }) as any;
							const validationRules = (validationRulesParam.rules || []) as Array<{
								propertyPath?: any;
								customPropertyPath?: any;
								checkType?: string;
								expectedValue?: any;
								valueType?: string;
							}>;

							if (validationRules.length === 0) {
								throw new SpeckleError(this.getNode(), 'Add at least one validation rule to use Object Property Validation.');
							}

							const rawObject = await client.fetchObject(projectId, objectId);

							const getValueByPath = (obj: any, path: string): any => {
								const parts = String(path || '').split('.').filter(Boolean);
								let current = obj;

								for (const part of parts) {
									if (current === null || current === undefined) {
										return undefined;
									}

									if (Array.isArray(current) && /^\d+$/.test(part)) {
										current = current[Number(part)];
									} else {
										current = current[part];
									}
								}

								return current;
							};

							const normalizeValidationValue = (val: any, valueType: string = 'auto', propertyPath?: string): any => {
								const selectedType = String(valueType || 'auto').toLowerCase();
								const pathLabel = propertyPath ? ` for "${propertyPath}"` : '';
								const stringValue = typeof val === 'string' ? val.trim() : val;

								if (selectedType === 'string') {
									return val === null || val === undefined ? '' : String(val);
								}

								if (selectedType === 'integer') {
									const parsed = Number(stringValue);
									if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
										throw new SpeckleError(this.getNode(), `Value${pathLabel} must be a valid integer.`);
									}
									return parsed;
								}

								if (selectedType === 'double') {
									const parsed = Number(stringValue);
									if (!Number.isFinite(parsed)) {
										throw new SpeckleError(this.getNode(), `Value${pathLabel} must be a valid number.`);
									}
									return parsed;
								}

								if (selectedType === 'boolean') {
									if (val === true || stringValue === 'true' || stringValue === '1') {
										return true;
									}
									if (val === false || stringValue === 'false' || stringValue === '0') {
										return false;
									}
									throw new SpeckleError(this.getNode(), `Value${pathLabel} must be true or false for Boolean type.`);
								}

								if (selectedType === 'date') {
									const parsedDate = new Date(String(val));
									if (Number.isNaN(parsedDate.getTime())) {
										throw new SpeckleError(this.getNode(), `Value${pathLabel} must be a valid date.`);
									}
									return parsedDate.getTime();
								}

								if (typeof val === 'string' && val.trim() !== '' && !isNaN(Number(val)) && isFinite(Number(val))) {
									return Number(val);
								}
								if (stringValue === 'true' || val === true) {
									return true;
								}
								if (stringValue === 'false' || val === false) {
									return false;
								}
								return val;
							};

							const hasUsableValue = (value: any): boolean => {
								if (value === undefined || value === null) return false;
								if (typeof value === 'string') return value.trim() !== '';
								if (Array.isArray(value)) return value.length > 0;
								return true;
							};

							const results = validationRules.map((rule) => {
								const customPath = String(rule.customPropertyPath ?? '').trim();
								const selectedPath = customPath !== '' ? customPath : rule.propertyPath;
								const propertyPath = String(selectedPath ?? '').trim();
								const checkType = String(rule.checkType || 'hasValue');
								const valueType = String(rule.valueType || 'auto');
								const expectedValue = rule.expectedValue;

								if (!propertyPath) {
									return {
										propertyPath: '',
										checkType,
										valueType,
										actualValue: undefined,
										expectedValue,
										passed: false,
										error: 'No property path selected.',
									};
								}

								const actualValue = getValueByPath(rawObject, propertyPath);

								try {
									let passed = false;
									let normalizedActual: any = actualValue;
									let normalizedExpected: any = expectedValue;

									switch (checkType) {
										case 'hasValue':
											passed = hasUsableValue(actualValue);
											break;
										case 'isEmpty':
											passed = !hasUsableValue(actualValue);
											break;
										case 'isTrue':
											normalizedActual = normalizeValidationValue(actualValue, 'boolean', propertyPath);
											passed = normalizedActual === true;
											break;
										case 'isFalse':
											normalizedActual = normalizeValidationValue(actualValue, 'boolean', propertyPath);
											passed = normalizedActual === false;
											break;
										case 'contains':
											passed = String(actualValue ?? '').toLowerCase().includes(String(expectedValue ?? '').toLowerCase());
											break;
										case 'equals':
										case 'notEquals':
										case 'greaterThan':
										case 'greaterThanOrEqual':
										case 'lessThan':
										case 'lessThanOrEqual': {
											normalizedActual = normalizeValidationValue(actualValue, valueType, propertyPath);
											normalizedExpected = normalizeValidationValue(expectedValue, valueType, propertyPath);

											if (checkType === 'equals') {
												passed = typeof normalizedActual === 'string' || typeof normalizedExpected === 'string'
													? String(normalizedActual).toLowerCase() === String(normalizedExpected).toLowerCase()
													: normalizedActual === normalizedExpected;
											} else if (checkType === 'notEquals') {
												passed = typeof normalizedActual === 'string' || typeof normalizedExpected === 'string'
													? String(normalizedActual).toLowerCase() !== String(normalizedExpected).toLowerCase()
													: normalizedActual !== normalizedExpected;
											} else {
												const left = typeof normalizedActual === 'string' ? normalizedActual.toLowerCase() : normalizedActual;
												const right = typeof normalizedExpected === 'string' ? normalizedExpected.toLowerCase() : normalizedExpected;

												if (checkType === 'greaterThan') passed = left > right;
												if (checkType === 'greaterThanOrEqual') passed = left >= right;
												if (checkType === 'lessThan') passed = left < right;
												if (checkType === 'lessThanOrEqual') passed = left <= right;
											}
											break;
										}
										default:
											passed = false;
									}

									return {
										propertyPath,
										checkType,
										valueType,
										actualValue,
										normalizedActual,
										expectedValue,
										normalizedExpected,
										passed,
									};
								} catch (error: any) {
									return {
										propertyPath,
										checkType,
										valueType,
										actualValue,
										expectedValue,
										passed: false,
										error: error.message,
									};
								}
							});

							const passedRules = results.filter((result) => result.passed).length;
							const failedRules = results.length - passedRules;
							const isValid = validationMode === 'any' ? passedRules > 0 : failedRules === 0;

							responseData = {
								projectId,
								objectId,
								objectName: rawObject?.name ?? null,
								speckleType: rawObject?.speckle_type || rawObject?.speckleType || null,
								validationMode,
								isValid,
								totalRules: results.length,
								passedRules,
								failedRules,
								results,
							};
						} else if (operation === 'updateProperties') {
							// Use the already cleaned projectId from the case start
							const objectId = this.getNodeParameter('objectId', i) as string;
							const properties = this.getNodeParameter('propertiesToUpdate', i, { propertyValues: [] }) as any;
							const autoCommit = this.getNodeParameter('autoCommit', i, false) as boolean;

							// 1. Fetch existing object
							const rawObject = await client.fetchObject(projectId, objectId);
							
							// 2. Apply updates
							// We need a deep clone to avoid mutating cached objects
							const updatedObject = JSON.parse(JSON.stringify(rawObject));
							const originalApplicationId = rawObject?.applicationId;
							const propertyValues = (properties.propertyValues || []) as Array<{ propertyPath?: any; customPropertyPath?: any; value: any; valueType?: string }>;
							const createMissingPaths = this.getNodeParameter('createMissingPaths', i, false) as boolean;

							const normalizeValue = (val: any, valueType: string = 'auto', propertyPath?: string): any => {
								const selectedType = String(valueType || 'auto').toLowerCase();
								const pathLabel = propertyPath ? ` for "${propertyPath}"` : '';
								const stringValue = typeof val === 'string' ? val.trim() : val;

								if (selectedType === 'string') {
									return val === null || val === undefined ? '' : String(val);
								}

								if (selectedType === 'integer') {
									const parsed = Number(stringValue);
									if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
										throw new SpeckleError(this.getNode(), `Value${pathLabel} must be a valid integer.`);
									}
									return parsed;
								}

								if (selectedType === 'double') {
									const parsed = Number(stringValue);
									if (!Number.isFinite(parsed)) {
										throw new SpeckleError(this.getNode(), `Value${pathLabel} must be a valid number.`);
									}
									return parsed;
								}

								if (selectedType === 'boolean') {
									if (val === true || stringValue === 'true' || stringValue === '1') {
										return true;
									}
									if (val === false || stringValue === 'false' || stringValue === '0') {
										return false;
									}
									throw new SpeckleError(this.getNode(), `Value${pathLabel} must be true or false for Boolean type.`);
								}

								if (selectedType === 'date') {
									const parsedDate = new Date(String(val));
									if (Number.isNaN(parsedDate.getTime())) {
										throw new SpeckleError(this.getNode(), `Value${pathLabel} must be a valid date (for example 2026-04-08 or 2026-04-08T10:30:00Z).`);
									}
									return parsedDate.toISOString();
								}

								if (typeof val === 'string' && val.trim() !== '' && !isNaN(Number(val)) && isFinite(Number(val))) {
									return Number(val);
								}
								if (stringValue === 'true' || val === true) {
									return true;
								}
								if (stringValue === 'false' || val === false) {
									return false;
								}
								if (stringValue === 'null') {
									return null;
								}
								return val;
							};

							const setValueByPath = (obj: any, p: any, val: any, valueType: string = 'auto'): { previousValue: any; newValue: any; createdPath: boolean } => {
								if (!p) return { previousValue: undefined, newValue: val, createdPath: false };
								const pathStr = String(p);
								const parts = pathStr.split('.').filter(Boolean);
								if (parts.length === 0) return { previousValue: undefined, newValue: val, createdPath: false };

								let cur: any = obj;
								let createdPath = false;
								for (let j = 0; j < parts.length - 1; j++) {
									const part = parts[j];
									if (!cur[part] || typeof cur[part] !== 'object') {
										if (!createMissingPaths) {
											throw new SpeckleError(this.getNode(), `Property path "${pathStr}" does not exist on the object. Use a field name like "name" instead of the current value like "${String(rawObject?.name ?? '')}". Enable "Create Missing Paths" only if you intentionally want to add a new property.`);
										}
										cur[part] = {};
										createdPath = true;
									}
									cur = cur[part];
								}
								
								const lastPart = parts[parts.length - 1];
								if (!(lastPart in cur) && !createMissingPaths) {
									throw new SpeckleError(this.getNode(), `Property path "${pathStr}" does not exist on the object. Use a field name like "name" instead of the current value like "${String(rawObject?.name ?? '')}". Enable "Create Missing Paths" only if you intentionally want to add a new property.`);
								}

								const previousValue = cur[lastPart];
								const finalVal = normalizeValue(val, valueType, pathStr);
								if (!(lastPart in cur)) {
									createdPath = true;
								}
								cur[lastPart] = finalVal;
								return { previousValue, newValue: finalVal, createdPath };
							};

							const appliedProperties: string[] = [];
							const changedProperties: Array<{ path: string; previousValue: any; newValue: any; createdPath: boolean; valueType: string }> = [];
							for (const prop of propertyValues) {
								const customPath = String(prop.customPropertyPath ?? '').trim();
								const selectedPath = customPath !== '' ? customPath : prop.propertyPath;
								if (selectedPath !== undefined && selectedPath !== null && String(selectedPath).trim() !== '') {
									const path = String(selectedPath).trim();
									const selectedValueType = String(prop.valueType || 'auto');
									const change = setValueByPath(updatedObject, path, prop.value, selectedValueType);
									appliedProperties.push(path);
									changedProperties.push({ path, previousValue: change.previousValue, newValue: change.newValue, createdPath: change.createdPath, valueType: selectedValueType });
								}
							}

							if (originalApplicationId !== undefined && originalApplicationId !== null) {
								updatedObject.applicationId = originalApplicationId;
							}

// 3. Compute new object ID (Speckle: MD5 of JSON with sorted keys, excluding id and __-prefixed fields)
								const objForHashing: Record<string, any> = {};
								for (const k of Object.keys(updatedObject).sort()) {
									if (k !== 'id' && !k.startsWith('__')) objForHashing[k] = updatedObject[k];
								}
								const newObjectId = crypto.createHash('md5').update(JSON.stringify(objForHashing)).digest('hex');
								updatedObject.id = newObjectId;

								// Ensure speckle_type (snake_case) exists as REST API often prefers it
								if (!updatedObject.speckle_type && updatedObject.speckleType) {
									updatedObject.speckle_type = updatedObject.speckleType;
								}

								// 4. Upload to Speckle via multipart/form-data
								try {
									await client.uploadObjects(projectId, [updatedObject]);
								} catch (uploadError: any) {
									if (enableDebug) {
										console.error('[Speckle] Object upload failed. Payload sample:', JSON.stringify(updatedObject).slice(0, 500));
									}
									throw new SpeckleError(this.getNode(), `Failed to upload updated object to Speckle: ${uploadError.message}`);
								}

							const updateResult: any = {
								oldObjectId: objectId,
								newObjectId,
								updatedProperties: appliedProperties,
								changedProperties,
								projectId,
								applicationId: originalApplicationId ?? null,
								sourceApplication: null,
								sourceApplicationPreserved: false,
							};

							if (autoCommit) {
								const targetModelId = getId('targetModelId');
								const message = this.getNodeParameter("commitMessage", i, "Updated properties via n8n") as string;
								const debugSteps: any[] = [];

								if (!versionId) {
									throw new SpeckleError(this.getNode(), "Auto-Commit requires a Version ID so the full model tree can be reconstructed. Please fill in the Version ID field.");
								}

								// Resolve version root and preserve the original source application
								const versionInfo = await client.makeGraphQLRequest(queries.getVersionObjects, { projectId, modelId, versionId });
								const rootObjectId = versionInfo?.project?.model?.version?.referencedObject;
								const originalSourceApplication = versionInfo?.project?.model?.version?.sourceApplication;
								if (!rootObjectId) {
									throw new SpeckleError(this.getNode(), "Could not resolve the root object for the provided Version ID.");
								}
								debugSteps.push({ step: "resolvedRoot", rootObjectId, sourceApplication: originalSourceApplication });

								// ── Helpers ─────────────────────────────────────────────────────────────
								const replaceRefById = (node: any, oldId: string, newId: string): number => {
									let replacements = 0;
									const walk = (n: any): void => {
										if (!n || typeof n !== "object") return;
										if (Array.isArray(n)) {
											for (let idx = 0; idx < n.length; idx++) {
												const item = n[idx];
												if (item && typeof item === "object" && item.referencedId === oldId) {
													n[idx] = { referencedId: newId, speckle_type: "reference" };
													replacements++;
												} else { walk(item); }
											}
										} else {
											for (const k of Object.keys(n)) {
												if (k === "id" || k.startsWith("__")) continue;
												const v = n[k];
												if (v && typeof v === "object") {
													if (!Array.isArray(v) && v.referencedId === oldId) { n[k] = { referencedId: newId, speckle_type: "reference" }; replacements++; }
													else { walk(v); }
												}
											}
										}
									};
									walk(node);
									return replacements;
								};

								const collectDirectRefs = (node: any): string[] => {
									const refs: string[] = [];
									const walk = (n: any): void => {
										if (!n || typeof n !== "object") return;
										if (Array.isArray(n)) { n.forEach(walk); return; }
										if (n.referencedId && typeof n.referencedId === "string") { refs.push(n.referencedId); return; }
										for (const k of Object.keys(n)) { if (k !== "id" && !k.startsWith("__")) walk(n[k]); }
									};
									walk(node); return refs;
								};

								const speckleHash = (obj: any): string => {
									const clean: Record<string, any> = {};
									for (const k of Object.keys(obj).sort()) {
										if (k !== "id" && !k.startsWith("__")) clean[k] = obj[k];
									}
									return crypto.createHash("md5").update(JSON.stringify(clean)).digest("hex");
								};

								interface PathNode { id: string; data: any; }
								const findPath = async (startId: string, targetId: string): Promise<PathNode[] | null> => {
									const path: PathNode[] = [];
									let currentId = startId;
									for (let depth = 0; depth < 20; depth++) {
										const data = await client.fetchObject(projectId, currentId);
										path.push({ id: currentId, data });
										if (currentId === targetId) return path;
										const directRefs = collectDirectRefs(data);
										debugSteps.push({ step: "pathSearch", nodeId: currentId, directRefsCount: directRefs.length, directRefs: directRefs.slice(0,20) });
										if (directRefs.length === 0) return null;
										let nextId: string | null = null;
										for (const refId of directRefs) {
											if (refId === targetId) { nextId = refId; break; }
											const refClosure = await client.getObjectClosureIds(projectId, refId);
											debugSteps.push({ step: "closureCheck", refId, closureSize: Object.keys(refClosure).length, containsTarget: (targetId in refClosure) });
											if (targetId in refClosure) { nextId = refId; break; }
										}
										if (!nextId) return null;
										currentId = nextId;
									}
									return null;
								};

								// ── Find path root → … → element ──────────────────────────────────────
								const objectPath = await findPath(rootObjectId, objectId);
								debugSteps.push({ step: "pathResult", found: !!objectPath, pathLength: objectPath?.length ?? 0, pathIds: objectPath?.map(p => p.id) ?? [] });
								if (enableDebug) updateResult._debug = debugSteps;

								if (!objectPath) {
									throw new SpeckleError(this.getNode(), 'Object ' + objectId + ' was not found in the version tree of the given Version ID.');
								}

								// ── Patch bottom-up, re-hashing each level ─────────────────────────────
								const newIds: string[] = new Array(objectPath.length);
								newIds[objectPath.length - 1] = newObjectId;

								const patchedObjects: any[] = [];
								for (let pi = objectPath.length - 2; pi >= 0; pi--) {
									const parentCopy = JSON.parse(JSON.stringify(objectPath[pi].data));
									const refsReplaced = replaceRefById(parentCopy, objectPath[pi + 1].id, newIds[pi + 1]);

									// Prefer the __closure already in the fetched object's data field —
									// it has correct depth values. Fall back to the server children query
									// (returns everything at depth=1) only when inline closure is absent.
									const inlineClosure = (parentCopy.__closure && typeof parentCopy.__closure === 'object' && Object.keys(parentCopy.__closure).length > 0)
										? JSON.parse(JSON.stringify(parentCopy.__closure)) as Record<string, number>
										: null;
									let patchedClosure: Record<string, number>;
									let closureSource: string;
									if (inlineClosure) {
										patchedClosure = inlineClosure;
										closureSource = 'inline';
									} else {
										patchedClosure = await client.getObjectClosureIds(projectId, objectPath[pi].id);
										closureSource = Object.keys(patchedClosure).length > 0 ? 'server-query' : 'empty';
									}

									for (let k = pi + 1; k < objectPath.length; k++) {
										const oldCId = objectPath[k].id;
										if (oldCId in patchedClosure) { patchedClosure[newIds[k]] = patchedClosure[oldCId]; delete patchedClosure[oldCId]; }
										else { patchedClosure[newIds[k]] = 1; }
									}
									parentCopy.__closure = patchedClosure;

									newIds[pi] = speckleHash(parentCopy);
									parentCopy.id = newIds[pi];
									if (!parentCopy.speckle_type && parentCopy.speckleType) parentCopy.speckle_type = parentCopy.speckleType;
									patchedObjects.push(parentCopy);

									debugSteps.push({ step: "patchedLevel", pi, originalId: objectPath[pi].id, newId: newIds[pi], refsReplaced, closureSource, closureSize: Object.keys(patchedClosure).length, closureSample: Object.keys(patchedClosure).slice(0,5) });
								}
								const newRootId = newIds[0];

								const uploadedIds = await client.uploadObjects(projectId, patchedObjects);
								debugSteps.push({ step: 'uploaded', count: patchedObjects.length, uploadedIds });

								// Verify the new root landed on the server. Diagnostic-only — do NOT throw
								// so _debug is always present in the output even when verify fails.
								try {
									const verifiedRoot = await client.fetchObject(projectId, newRootId);
									debugSteps.push({
										step: 'verifyUpload',
										success: true,
										speckle_type: verifiedRoot?.speckle_type,
										inlineClosureSize: Object.keys(verifiedRoot?.__closure ?? {}).length,
										topLevelKeys: Object.keys(verifiedRoot ?? {}).filter(k => !k.startsWith('__')).slice(0, 10),
									});
								} catch (verifyErr: any) {
									// Object not found — likely a hash mismatch or upload silently failed.
									// We still create the version so the viewer can tell us what happened.
									debugSteps.push({
										step: 'verifyUpload',
										success: false,
										error: String(verifyErr?.message ?? verifyErr),
										newRootId,
										note: 'Version will still be created; check viewer and _debug to diagnose.',
									});
								}

								const commitResponse = await client.makeGraphQLRequest(mutations.versionCreate, {
									projectId, modelId: targetModelId, objectId: newRootId, message,
								});
								const createdVersion = commitResponse.versionMutations.create;
								const sourceApplicationResult = await preserveVersionSourceApplication(
									client,
									projectId,
									createdVersion?.id,
									originalSourceApplication,
									'Preserved source application after n8n property update',
								);
								updateResult.version = {
									...createdVersion,
									sourceApplication: originalSourceApplication ?? createdVersion?.sourceApplication,
								};
								updateResult.newRootObjectId = newRootId;
								updateResult.applicationId = originalApplicationId ?? null;
								updateResult.sourceApplication = originalSourceApplication ?? null;
								updateResult.sourceApplicationPreserved = sourceApplicationResult.success;
								if (sourceApplicationResult.warning) {
									updateResult.sourceApplicationWarning = sourceApplicationResult.warning;
								}
								if (enableDebug) updateResult._debug = debugSteps;
							}

							responseData = updateResult;
						} else if (operation === 'analyzeModel') {
						const applicationHint = this.getNodeParameter('applicationHint', i, 'auto') as string;
						const maxElements = this.getNodeParameter('maxElements', i, 0) as number;
						const batchSize = this.getNodeParameter('batchSize', i, 500) as number;
						const analyticsTopCategories = this.getNodeParameter('analyticsTopCategories', i, 10) as number;
						const analyticsOutputFormat = this.getNodeParameter('analyticsOutputFormat', i, 'metabase') as string;

						const versionRespAnalytics = await client.makeGraphQLRequest(queries.getVersionObjects, { projectId, modelId, versionId });
						const referencedObjectIdAnalytics = versionRespAnalytics?.project?.model?.version?.referencedObject;
						const detectedSourceApplication = versionRespAnalytics?.project?.model?.version?.sourceApplication;
						if (!referencedObjectIdAnalytics) {
							throw new SpeckleError(this.getNode(), 'Referenced object not found for the provided version');
						}

						const sourceApplication = applicationHint !== 'auto' ? applicationHint : detectedSourceApplication;
						const realElements: any[] = [];
						let cursorAnalytics: string | null = null;
						let totalFetched = 0;
						let isPartialAnalysis = false;

						do {
							const pageResult = await client.getObjectMetadataDynamic(
								projectId,
								referencedObjectIdAnalytics,
								sourceApplication,
								batchSize,
								cursorAnalytics,
							);
							cursorAnalytics = pageResult.cursor;

							for (const obj of pageResult.objects ?? []) {
								if (!isRealBIMElement(obj)) {
									continue;
								}

								realElements.push(obj);
								totalFetched++;

								if (maxElements > 0 && totalFetched >= maxElements) {
									cursorAnalytics = null;
									isPartialAnalysis = true;
									break;
								}
							}
						} while (cursorAnalytics);

						const analytics = buildModelAnalytics(
							realElements,
							sourceApplication,
							analyticsTopCategories,
							isPartialAnalysis,
							maxElements > 0 ? maxElements : undefined,
						);

						const analyzedAt = new Date().toISOString();
						const summaryRow = {
							rowType: 'summary',
							chartGroup: 'summary',
							recommendedChart: 'scalar',
							projectId,
							modelId,
							versionId,
							referencedObjectId: referencedObjectIdAnalytics,
							sourceApplication: sourceApplication ?? 'Unknown',
							sourceApplicationId: analytics.summary.sourceApplicationId,
							totalElements: analytics.summary.totalElements,
							category: analytics.summary.topCategory ?? 'All Elements',
							count: analytics.summary.totalElements,
							percentage: 100,
							rank: 0,
							topCategory: analytics.summary.topCategory,
							groupedCategoryCount: analytics.summary.groupedCategoryCount,
							rawCategoryCount: analytics.summary.rawCategoryCount,
							isPartialAnalysis: analytics.summary.isPartialAnalysis,
							analyzedElementLimit: analytics.summary.analyzedElementLimit,
							analyzedAt,
						};

						const metabaseRows = [
							summaryRow,
							...analytics.categories.map((row, index) => ({
								rowType: 'category',
								chartGroup: 'category',
								recommendedChart: 'bar',
								projectId,
								modelId,
								versionId,
								referencedObjectId: referencedObjectIdAnalytics,
								sourceApplication: sourceApplication ?? 'Unknown',
								sourceApplicationId: analytics.summary.sourceApplicationId,
								totalElements: analytics.summary.totalElements,
								category: row.label,
								count: row.count,
								percentage: row.percentage,
								rank: index + 1,
								analyzedAt,
							})),
							...analytics.disciplines.map((row, index) => ({
								rowType: 'discipline',
								chartGroup: 'discipline',
								recommendedChart: 'pie',
								projectId,
								modelId,
								versionId,
								referencedObjectId: referencedObjectIdAnalytics,
								sourceApplication: sourceApplication ?? 'Unknown',
								sourceApplicationId: analytics.summary.sourceApplicationId,
								totalElements: analytics.summary.totalElements,
								category: row.label,
								count: row.count,
								percentage: row.percentage,
								rank: index + 1,
								analyzedAt,
							})),
							...analytics.rawCategories.map((row, index) => ({
								rowType: 'rawCategory',
								chartGroup: 'rawCategory',
								recommendedChart: 'row',
								projectId,
								modelId,
								versionId,
								referencedObjectId: referencedObjectIdAnalytics,
								sourceApplication: sourceApplication ?? 'Unknown',
								sourceApplicationId: analytics.summary.sourceApplicationId,
								totalElements: analytics.summary.totalElements,
								category: row.label,
								count: row.count,
								percentage: row.percentage,
								rank: index + 1,
								analyzedAt,
							})),
						];

						if (analyticsOutputFormat === 'metabase') {
							responseData = metabaseRows;
						} else {
							responseData = {
								projectId,
								modelId,
								versionId,
								referencedObjectId: referencedObjectIdAnalytics,
								sourceApplication: sourceApplication ?? 'Unknown',
								...analytics,
								metabaseSummary: summaryRow,
								...(analyticsOutputFormat === 'both' ? { metabaseRows } : {}),
							};
						}
						} else if (operation === 'extractElementTable') {
						const tableSource = this.getNodeParameter('tableSource', i, 'auto') as string;
						const elementTypeFilter = this.getNodeParameter('teklaElementTypes', i, 'all') as string;
						const includeUserProperties = this.getNodeParameter('includeUserProperties', i, true) as boolean;
						const categoryFilter = this.getNodeParameter('revitCategory', i, 'all') as string;
						const revitIncludeInstanceParams = Boolean(this.getNodeParameter('revitIncludeInstanceParams', i, true));
						const revitIncludeTypeParams = Boolean(this.getNodeParameter('revitIncludeTypeParams', i, false));
						const maxElements = this.getNodeParameter('maxElements', i, 0) as number;
						const batchSize = this.getNodeParameter('batchSize', i, 500) as number;

						// Maps English dropdown value → Revit BuiltInCategory OST_ constant.
						// OST_ values are language-independent and work for any locale (DE, EN, FR, …).
						const categoryToOST: Record<string, string> = {
							'Ceilings':                'OST_Ceilings',
							'Columns':                 'OST_Columns',
							'Curtain Panels':          'OST_CurtainWallPanels',
							'Curtain Wall Mullions':   'OST_CurtainWallMullions',
							'Doors':                   'OST_Doors',
							'Floors':                  'OST_Floors',
							'Generic Models':          'OST_GenericModel',
							'Railings':                'OST_Railings',
							'Ramps':                   'OST_Ramps',
							'Roofs':                   'OST_Roofs',
							'Rooms':                   'OST_Rooms',
							'Stairs':                  'OST_Stairs',
							'Walls':                   'OST_Walls',
							'Windows':                 'OST_Windows',
							'Structural Columns':      'OST_StructuralColumns',
							'Structural Foundations':  'OST_StructuralFoundation',
							'Structural Framing':      'OST_StructuralFraming',
							'Structural Stiffeners':   'OST_StructuralStiffeners',
							'Cable Trays':             'OST_CableTray',
							'Conduits':                'OST_Conduit',
							'Ducts':                   'OST_DuctCurves',
							'Electrical Equipment':    'OST_ElectricalEquipment',
							'Electrical Fixtures':     'OST_ElectricalFixtures',
							'Mechanical Equipment':    'OST_MechanicalEquipment',
							'Pipes':                   'OST_PipeCurves',
							'Plumbing Fixtures':       'OST_PlumbingFixtures',
							'Furniture':               'OST_Furniture',
							'Furniture Systems':       'OST_FurnitureSystems',
							'Spaces':                  'OST_MEPSpaces',
							'Areas':                   'OST_Areas',
						};

						const versionRespTable = await client.makeGraphQLRequest(queries.getVersionObjects, { projectId, modelId, versionId });
						const referencedObjectIdTable = versionRespTable?.project?.model?.version?.referencedObject;
						const detectedSourceApplication = versionRespTable?.project?.model?.version?.sourceApplication;
						if (!referencedObjectIdTable) {
							throw new SpeckleError(this.getNode(), 'Referenced object not found for the provided version');
						}

						// A chosen source application overrides whatever the version reports
						const forcedSource: Record<string, string> = { ifc: 'IFC', revit: 'Revit', tekla: 'Tekla' };
						const sourceApplication = forcedSource[tableSource] ?? detectedSourceApplication;

						let totalFetched = 0;
						let cursorTable: string | null = null;
						let earlyExit = false;

						do {
							const pageResult = await client.getObjectMetadata(projectId, referencedObjectIdTable, batchSize, cursorTable);
							cursorTable = pageResult.cursor;

							for (const obj of pageResult.objects ?? []) {
								if (!isRealBIMElement(obj)) {
									continue;
								}

								const sourceApplicationId = detectSourceApplicationId(obj, sourceApplication);
								if (tableSource !== 'auto' && sourceApplicationId !== tableSource) {
									continue;
								}

								if (sourceApplicationId === 'tekla' && elementTypeFilter !== 'all') {
									const speckleType: string = obj.speckle_type || obj.speckleType || '';
									const isNewConnector = speckleType.includes('TeklaObject');
									const typeName = isNewConnector
										? (obj.type ?? '')
										: (speckleType.split('.').pop() ?? '');
									if (typeName !== elementTypeFilter) {
										continue;
									}
								}

								if (sourceApplicationId === 'revit' && categoryFilter !== 'all') {
									const targetOST = categoryToOST[categoryFilter];
									const objBIC = (obj.properties?.builtInCategory ?? obj.builtInCategory ?? '').toString().trim();
									const matchesBIC = Boolean(targetOST && objBIC && objBIC === targetOST);
									if (!matchesBIC) {
										const objCategory = (obj.category ?? obj.Category ?? obj.properties?.category ?? '').toString().trim();
										if (objCategory !== categoryFilter) {
											continue;
										}
									}
								}

								const row = extractElementRow(obj, {
									sourceApplication,
									includeUserProperties,
									includeInstanceParams: revitIncludeInstanceParams,
									includeTypeParams: revitIncludeTypeParams,
								});
								const execData = this.helpers.constructExecutionMetaData(
									this.helpers.returnJsonArray(row),
									{ itemData: { item: i } }
								);
								returnData.push(...execData);
								totalFetched++;

								if (maxElements > 0 && totalFetched >= maxElements) {
									cursorTable = null;
									earlyExit = true;
									break;
								}
							}
						} while (cursorTable && !earlyExit);

						// Rows pushed directly — skip normal responseData assignment
						responseData = [];
						} else if (operation === 'fetchGraph') {
							const streamId = getId('projectId');
							const objectId = this.getNodeParameter('objectId', i) as string;
							const options = this.getNodeParameter('fetchGraphOptions', i, {}) as {
								maxDepth?: number;
								includeMetadata?: boolean;
								flattenArrays?: boolean;
							};

							responseData = await fetchObjectGraph(
								client,
								streamId,
								objectId,
								options
							);
						} else if (operation === 'validateIds') {
							// Get and validate binaryPropertyName parameter
							let binaryPropertyName = this.getNodeParameter('binaryPropertyName', i, 'data');

							// Ensure it's a string - handle cases where it might be an object or other type
							if (typeof binaryPropertyName !== 'string') {
								throw new SpeckleError(
									this.getNode(),
									`Binary Property parameter must be a string, got ${typeof binaryPropertyName}. ` +
									`Value: ${JSON.stringify(binaryPropertyName)}. ` +
									`Please ensure you've entered a valid property name (e.g., 'data') and not an expression that evaluates to an object.`
								);
							}

							binaryPropertyName = binaryPropertyName.trim();

							if (!binaryPropertyName) {
								throw new SpeckleError(
									this.getNode(),
									`Binary Property parameter cannot be empty. Please specify the name of the binary property containing the IDS file (e.g., 'data').`
								);
							}

							const items = this.getInputData();
							const item = items[i];

							if (!item.binary) {
								throw new SpeckleError(
									this.getNode(),
									`No binary data found on item ${i}. Please ensure the input item contains binary data. ` +
									`Available properties: ${Object.keys(item).join(', ')}`
								);
							}

							if (!item.binary[binaryPropertyName]) {
								const availableBinaryProps = Object.keys(item.binary).join(', ') || 'none';
								throw new SpeckleError(
									this.getNode(),
									`Binary data property '${binaryPropertyName}' does not exist on item ${i}. ` +
									`Available binary properties: ${availableBinaryProps}`
								);
							}

							const binaryDataBuffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
							const idsXml = binaryDataBuffer.toString('utf8');

							let objectsToValidate: any[] = [];
							// If the input JSON is an array (rare in n8n unless explicit), use it. 
							// Otherwise assume the item itself is the object to validate.
							// We check if 'json' itself is an array or if we should validate the properties of json.
							// Speckle objects are usually { id:..., properties:... }
							if (Array.isArray(item.json)) {
								objectsToValidate = item.json;
							} else {
								objectsToValidate = [item.json];
							}

							const validationReport = await validateObjectsAgainstIds(objectsToValidate, idsXml);

							responseData = {
								summary: validationReport.summary,
								results: validationReport.results,
								passed: validationReport.passed
							};

						} else {
							// Unknown operation
							throw new SpeckleError(this.getNode(), `Unknown object operation: ${operation}`);
						}
						break;

					}
					case 'user': {
						if (operation === 'get') {
							const response = await client.makeGraphQLRequest(queries.activeUser);
							responseData = response.activeUser;
						} else if (operation === 'search') {
							const query = this.getNodeParameter('query', i) as string;
							const limit = this.getNodeParameter('limit', i, 10) as number;
							const response = await client.makeGraphQLRequest(queries.userSearch, { query, limit });
							responseData = response.userSearch.items;
						}
						break;
					}
					case 'server': {
						const response = await client.makeGraphQLRequest(queries.serverInfo);
						responseData = response.serverInfo;
						break;
					}
					case 'comment': {
						const projectId = getId('projectId');

						const buildTipTapDoc = (text: string) => ({
							type: 'doc',
							content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
						});

						if (operation === 'create') {
							const text = this.getNodeParameter('commentText', i) as string;
							const resourceIdString = this.getNodeParameter('resourceIdString', i, '') as string;

							const response = await client.makeGraphQLRequest(mutations.commentCreate, {
								projectId,
								content: buildTipTapDoc(text),
								resourceIdString,
							});
							responseData = response.commentMutations.create;
						} else if (operation === 'reply') {
							const text = this.getNodeParameter('commentText', i) as string;
							const commentId = this.getNodeParameter('commentId', i) as string;

							const response = await client.makeGraphQLRequest(mutations.commentReply, {
								projectId,
								threadId: commentId,
								content: buildTipTapDoc(text),
							});
							responseData = response.commentMutations.reply;
						} else if (operation === 'archive') {
							const commentId = this.getNodeParameter('commentId', i) as string;
							const archived = this.getNodeParameter('archived', i, true) as boolean;

							const response = await client.makeGraphQLRequest(mutations.commentArchive, { projectId, commentId, archived });
							responseData = { success: response.commentMutations.archive, commentId, archived };
						} else if (operation === 'edit') {
							const text = this.getNodeParameter('commentText', i) as string;
							const commentId = this.getNodeParameter('commentId', i) as string;

							const response = await client.makeGraphQLRequest(mutations.commentEdit, {
								projectId,
								commentId,
								content: buildTipTapDoc(text),
							});
							responseData = response.commentMutations.edit;
						} else if (operation === 'markViewed') {
							const commentId = this.getNodeParameter('commentId', i) as string;

							const response = await client.makeGraphQLRequest(mutations.commentMarkViewed, { projectId, commentId });
							responseData = { success: response.commentMutations.markViewed, commentId };
						} else if (operation === 'getProjectComments') {
							const limit = this.getNodeParameter('limit', i, 20) as number;
							const response = await client.makeGraphQLRequest(queries.projectComments, {
								projectId,
								limit
							});

							// Helper function to extract text from nested document structure
							const extractText = (textObj: any): string => {
								if (!textObj?.doc?.content) return '';
								try {
									const extractNodes = (nodes: any[]): string[] => {
										const parts: string[] = [];
										for (const node of nodes) {
											if (typeof node?.text === 'string') {
												parts.push(node.text);
											}
											if (Array.isArray(node?.content)) {
												parts.push(...extractNodes(node.content));
											}
										}
										return parts;
									};

									return extractNodes(textObj.doc.content).join('\n').trim();
								} catch (e) {
									// If extraction fails, return empty string
									return '';
								}
								return '';
							};

							const commentText = (comment: any): string => extractText(comment?.text) || comment?.rawText || '';

							// Process comment threads with sorting and text extraction
							const processedThreads = response.project.commentThreads.items.map((thread: any) => {
								const processedThread: any = {
									id: thread.id,
									createdAt: thread.createdAt,
									updatedAt: thread.updatedAt,
									archived: thread.archived,
									replyCount: thread.replies.totalCount,
								};

								processedThread.initialComment = {
									id: thread.id,
									text: commentText(thread),
									createdAt: thread.createdAt,
									archived: thread.archived,
									author: thread.author ?? null,
									rawText: thread.text ?? thread.rawText ?? null,
								};

								const sortedReplies = [...(thread.replies.items ?? [])]
									.sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

								processedThread.responses = sortedReplies.map((reply: any) => ({
									id: reply.id,
									text: commentText(reply),
									createdAt: reply.createdAt,
									archived: reply.archived,
									author: reply.author,
									rawText: reply.text ?? reply.rawText ?? null,
								}));

								return processedThread;
							});

							responseData = {
								project: {
									id: response.project.id,
									name: response.project.name,
								},
								totalThreads: response.project.commentThreads.totalCount,
								threads: processedThreads,
							};
						}
						break;
					}
					case 'token': {
						if (operation === 'create') {
							const name = this.getNodeParameter('tokenName', i) as string;
							const scopes = this.getNodeParameter('tokenScopes', i) as string[];
							const lifespanDays = this.getNodeParameter('tokenLifespanDays', i, 0) as number;
							const lifespan = lifespanDays > 0 ? lifespanDays * 24 * 60 * 60 * 1000 : null;
							try {
								const response = await client.makeGraphQLRequest(mutations.tokenCreate, { name, scopes, lifespan });
								responseData = { token: response.apiTokenCreate, name, scopes };
							} catch (error: any) {
								const errorMessage = error?.message || '';
								if (errorMessage.includes('tokens:write')) {
									throw new SpeckleError(
										this.getNode(),
										'Creating API tokens requires the credential used by this node to already have the `tokens:write` scope. Create or update your Speckle personal access token in Developer Settings, then retry.',
									);
								}
								throw error;
							}
						} else if (operation === 'revoke') {
							const token = this.getNodeParameter('tokenToRevoke', i) as string;
							const response = await client.makeGraphQLRequest(mutations.tokenRevoke, { token });
							responseData = { success: response.apiTokenRevoke };
						}
						break;
					}
					default:
						throw new SpeckleError(this.getNode(), `Unknown resource: ${resource}`);
				}

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(responseData),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);

			} catch (error) {
				if (this.continueOnFail()) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
					returnData.push({ json: { error: errorMessage }, pairedItem: { item: i } });
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}


}

// Helper functions for Fetch Graph
async function fetchObjectGraph(
	client: SpeckleClient,
	streamId: string,
	objectId: string,
	options: {
		maxDepth?: number;
		includeMetadata?: boolean;
		flattenArrays?: boolean;
	},
): Promise<any> {
	const maxDepth = options.maxDepth ?? -1;
	const includeMetadata = options.includeMetadata ?? true;
	const flattenArrays = options.flattenArrays ?? false;

	const objectCache = new Map<string, any>();
	const visitedIds = new Set<string>();

	const fetchObject = async (objId: string, currentDepth: number): Promise<any> => {
		if (maxDepth !== -1 && currentDepth > maxDepth) {
			return { __reference: objId };
		}
		if (visitedIds.has(objId)) {
			return { __reference: objId };
		}
		if (objectCache.has(objId)) {
			return objectCache.get(objId);
		}
		visitedIds.add(objId);

		// Use SpeckleClient.fetchObject (which uses GraphQL) for robust fetching and caching
		const response = await client.fetchObject(streamId, objId);



		const processedObject = await processObject(
			response,
			currentDepth,
			fetchObject,
			includeMetadata,
			flattenArrays,
		);

		objectCache.set(objId, processedObject);
		return processedObject;
	};

	return await fetchObject(objectId, 0);
}

async function processObject(
	obj: any,
	currentDepth: number,
	fetchObject: (id: string, depth: number) => Promise<any>,
	includeMetadata: boolean,
	flattenArrays: boolean,
): Promise<any> {
	if (obj === null || obj === undefined) {
		return obj;
	}
	if (Array.isArray(obj)) {
		const processed = await Promise.all(
			obj.map((item) =>
				processObject(item, currentDepth, fetchObject, includeMetadata, flattenArrays),
			),
		);
		return flattenArrays ? processed.flat() : processed;
	}
	if (typeof obj !== 'object') {
		return obj;
	}
	if (obj.referencedId) {
		return await fetchObject(obj.referencedId, currentDepth + 1);
	}
	const result: any = {};
	const keysToProcess: [string, any][] = [];
	for (const [key, value] of Object.entries(obj)) {
		if (!includeMetadata && key.startsWith('__')) {
			continue;
		}
		if (key === 'id' || key === '__closure') {
			if (includeMetadata) {
				result[key] = value;
			}
			continue;
		}
		keysToProcess.push([key, value]);
	}
	const processedValues = await Promise.all(
		keysToProcess.map(([, value]) =>
			processObject(value, currentDepth, fetchObject, includeMetadata, flattenArrays),
		),
	);
	keysToProcess.forEach(([key], idx) => {
		result[key] = processedValues[idx];
	});
	return result;
}

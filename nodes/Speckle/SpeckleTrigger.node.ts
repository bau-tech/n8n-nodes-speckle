import {
	IHookFunctions,
	IWebhookFunctions,
	IWebhookResponseData,
	INodeType,
	INodeTypeDescription,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	IDataObject,
} from 'n8n-workflow';
import { queries } from './graphql/queries';
import { mutations } from './graphql/mutations';
import { SpeckleCredentials } from './types';

// Lightweight GraphQL POST — mirrors the raw request pattern used by Speckle.node.ts's
// loadOptions methods. Kept separate from SpeckleClient because that class is typed for
// IExecuteFunctions/ILoadOptionsFunctions only, and hook/webhook lifecycle methods run
// under IHookFunctions instead.
async function graphqlRequest(
	ctx: IHookFunctions | ILoadOptionsFunctions,
	credentials: SpeckleCredentials,
	query: string,
	variables?: IDataObject,
): Promise<any> {
	const response = await ctx.helpers.request({
		method: 'POST',
		url: `${credentials.serverUrl}/graphql`,
		headers: {
			Authorization: `Bearer ${credentials.token}`,
			'Content-Type': 'application/json',
		},
		body: { query, variables },
		json: true,
	});

	if (response?.errors?.length) {
		throw new Error(response.errors.map((e: any) => e.message).join('; '));
	}

	return response.data;
}

// Display names use Speckle's current Project/Model/Version terminology, but the `value`s
// are the raw webhook trigger strings the server actually expects — these are still the
// legacy stream/branch/commit action-type names even on current server versions (Speckle
// intentionally kept these unchanged for webhook backward-compatibility when the public
// API was renamed to Project/Model/Version). Do not change the values.
//
// "Project Created" (stream_create) and "Project Cloned" (stream_clone) are deliberately
// omitted: both fire with the *new* project's ID, but a webhook can only be attached to a
// project that already exists, so no webhook can ever be listening in time to receive them.
const TRIGGER_EVENT_OPTIONS = [
	// Project (stream_*)
	{ name: 'Project Updated', value: 'stream_update' },
	{ name: 'Project Deleted', value: 'stream_delete' },
	{ name: 'Project Access Granted', value: 'stream_permissions_add' },
	{ name: 'Project Access Removed', value: 'stream_permissions_remove' },
	{ name: 'Project Invite Sent', value: 'stream_invite_sent' },
	{ name: 'Project Invite Accepted', value: 'stream_permissions_invite_accepted' },
	{ name: 'Project Invite Declined', value: 'stream_invite_declined' },
	{ name: 'Project Access Requested', value: 'stream_access_request_sent' },
	{ name: 'Project Access Request Declined', value: 'stream_access_request_declined' },
	// Model (branch_*)
	{ name: 'Model Created', value: 'branch_create' },
	{ name: 'Model Updated', value: 'branch_update' },
	{ name: 'Model Deleted', value: 'branch_delete' },
	// Version (commit_*)
	{ name: 'Version Created', value: 'commit_create' },
	{ name: 'Version Updated', value: 'commit_update' },
	{ name: 'Version Received', value: 'commit_receive' },
	{ name: 'Version Deleted', value: 'commit_delete' },
	{ name: 'Version Moved', value: 'commit_move' },
	// Comment
	{ name: 'Comment Created', value: 'comment_created' },
	{ name: 'Comment Archived', value: 'comment_archived' },
	{ name: 'Comment Reply', value: 'comment_replied' },
	{ name: 'Comment Mention', value: 'comment_mention' },
];

export class SpeckleTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Speckle Trigger',
		name: 'speckleTrigger',
		icon: 'file:speckle.svg',
		group: ['trigger'],
		version: 1,
		description: 'Starts the workflow on Speckle project events (new version, comment, etc.) via a managed webhook',
		defaults: {
			name: 'Speckle Trigger',
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'speckleApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Project',
				name: 'projectId',
				type: 'options',
				required: true,
				typeOptions: {
					loadOptionsMethod: 'getProjects',
				},
				default: '',
				description: 'The Speckle project to watch for events. This node creates and manages a webhook on this project automatically.',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: TRIGGER_EVENT_OPTIONS,
				default: ['commit_create'],
				description: 'Which project events should trigger this workflow',
			},
		],
	};

	methods = {
		loadOptions: {
			async getProjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = (await this.getCredentials('speckleApi')) as SpeckleCredentials;

				try {
					const data = await graphqlRequest(this, credentials, queries.listProjects, { limit: 100 });
					const projects = data?.activeUser?.projects?.items || [];

					return projects.map((project: any) => ({
						name: project.name,
						value: project.id,
						description: project.description || undefined,
					}));
				} catch (error) {
					console.error('Failed to load projects:', error);
					return [];
				}
			},
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				if (!webhookData.webhookId) {
					return false;
				}

				const credentials = (await this.getCredentials('speckleApi')) as SpeckleCredentials;
				const projectId = this.getNodeParameter('projectId') as string;

				try {
					const data = await graphqlRequest(this, credentials, queries.projectWebhook, {
						projectId,
						webhookId: webhookData.webhookId,
					});
					const exists = Boolean(data?.project?.webhooks?.items?.[0]);
					if (!exists) {
						delete webhookData.webhookId;
					}
					return exists;
				} catch {
					// If we can't confirm the webhook exists (e.g. project no longer accessible),
					// treat it as missing so n8n re-creates it.
					delete webhookData.webhookId;
					return false;
				}
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const projectId = this.getNodeParameter('projectId') as string;
				const events = this.getNodeParameter('events') as string[];
				const credentials = (await this.getCredentials('speckleApi')) as SpeckleCredentials;

				const data = await graphqlRequest(this, credentials, mutations.webhookCreate, {
					streamId: projectId,
					url: webhookUrl,
					description: 'Created automatically by the n8n Speckle Trigger node',
					triggers: events,
				});

				const webhookId = data?.webhookCreate;
				if (!webhookId) {
					return false;
				}

				const webhookData = this.getWorkflowStaticData('node');
				webhookData.webhookId = webhookId;
				webhookData.projectId = projectId;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				if (!webhookData.webhookId) {
					return true;
				}

				const projectId = this.getNodeParameter('projectId') as string;
				const credentials = (await this.getCredentials('speckleApi')) as SpeckleCredentials;

				try {
					await graphqlRequest(this, credentials, mutations.webhookDelete, {
						streamId: projectId,
						webhookId: webhookData.webhookId,
					});
				} catch {
					// Don't block deactivation if the webhook (or project) is already gone server-side.
				}

				delete webhookData.webhookId;
				delete webhookData.projectId;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const bodyData = this.getBodyData();
		return {
			workflowData: [this.helpers.returnJsonArray(bodyData)],
		};
	}
}

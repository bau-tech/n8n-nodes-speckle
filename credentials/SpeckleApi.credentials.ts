import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class SpeckleApi implements ICredentialType {
	name = 'speckleApi';
	displayName = 'Speckle';
	documentationUrl = 'https://github.com/bimgeek/speckle-mcp';

	properties: INodeProperties[] = [
		{
			displayName: 'Speckle Server URL',
			name: 'serverUrl',
			type: 'string',
			default: 'https://app.speckle.systems',
			placeholder: 'https://app.speckle.systems',
			description: 'The URL of your Speckle server instance',
		},
		{
			displayName: 'Personal Access Token',
			name: 'token',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description: 'Your Speckle personal access token. Get it from your Speckle account settings.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'Authorization': '=Bearer {{$credentials.token}}',
				'Content-Type': 'application/json',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.serverUrl}}',
			url: '/graphql',
			method: 'POST',
			body: {
				query: `query { activeUser { id name email } }`,
			},
		},
	};
}

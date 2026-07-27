export const queries = {
  listProjects: `
    query($limit: Int!, $cursor: String, $filter: UserProjectsFilter) {
      activeUser {
        projects(limit: $limit, cursor: $cursor, filter: $filter) {
          totalCount
          cursor
          items {
            id
            name
            description
            createdAt
            updatedAt
            role
          }
        }
      }
    }
  `,

  getModels: `
    query($projectId: String!, $limit: Int!, $cursor: String) {
      project(id: $projectId) {
        id
        models(limit: $limit, cursor: $cursor) {
          totalCount
          cursor
          items {
            id
            name
            description
            createdAt
            updatedAt
          }
        }
      }
    }
  `,


  getProject: `
    query($projectId: String!, $modelLimit: Int!) {
      project(id: $projectId) {
        id
        name
        description
        createdAt
        updatedAt
        role
        models(limit: $modelLimit) {
          items {
            id
            name
            description
            createdAt
            updatedAt
          }
        }
      }
    }
  `,

  getModelVersions: `
    query($projectId: String!, $modelId: String!, $limit: Int!, $cursor: String) {
      project(id: $projectId) {
        id
        name
        model(id: $modelId) {
          id
          name
          versions(limit: $limit, cursor: $cursor) {
            totalCount
            cursor
            items {
              id
              message
              createdAt
              sourceApplication
              referencedObject
              authorUser {
                id
                name
                avatar
              }
            }
          }
        }
      }
    }
  `,

  getModel: `
    query($projectId: String!, $modelId: String!) {
      project(id: $projectId) {
        id
        model(id: $modelId) {
          id
          name
          description
          createdAt
          updatedAt
        }
      }
    }
  `,

  // @deprecated Use REST API client.getVersionRest instead
  getVersionObjects: `
    query GetVersionObjects($projectId: String!, $modelId: String!, $versionId: String!) {
      project(id: $projectId) {
        id
        model(id: $modelId) {
          id
          version(id: $versionId) {
            id
            message
            referencedObject
            createdAt
            sourceApplication
            totalChildrenCount
          }
        }
      }
    }
  `,

  activeUser: `
    query {
      activeUser {
        id
        name
        email
        company
        role
        avatar
      }
    }
  `,

  userSearch: `
    query($query: String!, $limit: Int = 10) {
      userSearch(query: $query, limit: $limit) {
        items {
          id
          name
          avatar
        }
      }
    }
  `,

  serverInfo: `
    query {
      serverInfo {
        name
        company
        version
        adminContact
        canonicalUrl
      }
    }
  `,

  projectComments: `
    query($projectId: String!, $limit: Int!) {
      project(id: $projectId) {
        id
        name
        commentThreads(limit: $limit) {
          totalCount
          items {
            id
            text {
              doc
            }
            rawText
            createdAt
            updatedAt
            archived
            replies {
              totalCount
              items {
                id
                text {
                  doc
                }
                rawText
                createdAt
                archived
                author {
                  id
                  name
                  avatar
                }
              }
            }
          }
        }
      }
    }
  `,

  projectWebhooks: `
    query($projectId: String!) {
      project(id: $projectId) {
        id
        webhooks {
          items {
            id
            url
            description
            triggers
            enabled
            history(limit: 5) {
              items {
                status
                statusInfo
              }
            }
          }
        }
      }
    }
  `,

  projectWebhook: `
    query($projectId: String!, $webhookId: String!) {
      project(id: $projectId) {
        id
        webhooks(id: $webhookId) {
          items {
            id
            url
            description
            triggers
            enabled
            history(limit: 5) {
              items {
                status
                statusInfo
              }
            }
          }
        }
      }
    }
  `,

  projectBlobs: `
    query($projectId: String!, $limit: Int!) {
      project(id: $projectId) {
        id
        blobs(limit: $limit) {
          totalCount
          items {
            id
            fileName
            fileType
            fileSize
            uploadStatus
            createdAt
          }
        }
      }
    }
  `,

  getBlobMetadata: `
    query($projectId: String!, $blobId: String!) {
      project(id: $projectId) {
        blob(id: $blobId) {
          id
          fileName
          fileType
          fileSize
          uploadStatus
        }
      }
    }
  `,

  projectActivity: `
    query($projectId: String!, $limit: Int!) {
      project(id: $projectId) {
        id
        versions(limit: $limit) {
          totalCount
          items {
            id
            message
            createdAt
            sourceApplication
            referencedObject
            authorUser {
              id
              name
              avatar
            }
            model {
              id
              name
            }
          }
        }
      }
    }
  `,

  getProjectTeam: `
    query($projectId: String!) {
      project(id: $projectId) {
        id
        name
        role
        team {
          id
          role
          user {
            id
            name
            company
            avatar
          }
        }
        invitedTeam {
          id
          title
          inviteId
          user {
            id
            name
          }
        }
      }
    }
  `,

};
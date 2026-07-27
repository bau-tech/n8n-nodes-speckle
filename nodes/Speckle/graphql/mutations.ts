export const mutations = {
  // ============================================
  // PROJECT MUTATIONS (streamCreate/Update/Delete)
  // ============================================
  // Project mutations
  projectCreate: `
    mutation($input: ProjectCreateInput!) {
      projectMutations {
        create(input: $input) {
          id
          name
          description
          visibility
          createdAt
          updatedAt
          role
        }
      }
    }
  `,
  projectUpdate: `
    mutation($update: ProjectUpdateInput!) {
      projectMutations {
        update(update: $update) {
          id
          name
          description
          visibility
          updatedAt
        }
      }
    }
  `,
  projectDelete: `
    mutation($projectId: String!) {
      projectMutations {
        delete(id: $projectId)
      }
    }
  `,

  projectInvite: `
    mutation($projectId: ID!, $email: String!, $role: String, $serverRole: String) {
      projectMutations {
        invites {
          create(projectId: $projectId, input: { email: $email, role: $role, serverRole: $serverRole }) {
            id
            name
            role
          }
        }
      }
    }
  `,

  projectRemoveUser: `
    mutation($projectId: String!, $userId: String!) {
      projectMutations {
        updateRole(input: { projectId: $projectId, userId: $userId, role: null }) {
          id
          name
        }
      }
    }
  `,

  // ============================================
  // MODEL MUTATIONS (branchCreate/Update)
  // ============================================

  modelCreate: `
    mutation($projectId: ID!, $name: String!, $description: String) {
      modelMutations {
        create(input: { projectId: $projectId, name: $name, description: $description }) {
          id
          name
          description
        }
      }
    }
  `,

  modelUpdate: `
    mutation($id: ID!, $projectId: ID!, $name: String, $description: String) {
      modelMutations {
        update(input: { id: $id, projectId: $projectId, name: $name, description: $description }) {
          id
          name
          description
        }
      }
    }
  `,

  // ============================================
  // VERSION MUTATIONS (commitCreate)
  // ============================================

  versionCreate: `
    mutation($projectId: String!, $modelId: String!, $objectId: String!, $message: String) {
      versionMutations {
        create(input: { projectId: $projectId, modelId: $modelId, objectId: $objectId, message: $message }) {
          id
          message
          referencedObject
          createdAt
        }
      }
    }
  `,

  versionUpdate: `
    mutation($projectId: ID!, $versionId: ID!, $message: String) {
      versionMutations {
        update(input: { projectId: $projectId, versionId: $versionId, message: $message }) {
          id
          message
        }
      }
    }
  `,

  versionDelete: `
    mutation($projectId: ID!, $versionIds: [ID!]!) {
      versionMutations {
        delete(input: { projectId: $projectId, versionIds: $versionIds })
      }
    }
  `,

  modelDelete: `
    mutation($id: ID!, $projectId: ID!) {
      modelMutations {
        delete(input: { id: $id, projectId: $projectId })
      }
    }
  `,

  // ============================================
  // ADDITIONAL VERSION MUTATIONS
  // ============================================

  versionMoveToModel: `
    mutation($projectId: ID!, $targetModelName: String!, $versionIds: [ID!]!) {
      versionMutations {
        moveToModel(input: { projectId: $projectId, targetModelName: $targetModelName, versionIds: $versionIds }) {
          id
          name
        }
      }
    }
  `,

  versionMarkReceived: `
    mutation($projectId: String!, $versionId: String!, $sourceApplication: String!, $message: String) {
      versionMutations {
        markReceived(input: { projectId: $projectId, versionId: $versionId, sourceApplication: $sourceApplication, message: $message })
      }
    }
  `,

  // ============================================
  // ADDITIONAL PROJECT MUTATIONS
  // ============================================

  projectLeave: `
    mutation($projectId: String!) {
      projectMutations {
        leave(id: $projectId)
      }
    }
  `,

  projectUpdateRole: `
    mutation($projectId: String!, $userId: String!, $role: String) {
      projectMutations {
        updateRole(input: { projectId: $projectId, userId: $userId, role: $role }) {
          id
          name
          team {
            id
            role
            user {
              id
              name
            }
          }
        }
      }
    }
  `,

  // ============================================
  // API TOKEN MUTATIONS
  // ============================================

  tokenCreate: `
    mutation($name: String!, $scopes: [String!]!, $lifespan: BigInt) {
      apiTokenCreate(token: { name: $name, scopes: $scopes, lifespan: $lifespan })
    }
  `,

  tokenRevoke: `
    mutation($token: String!) {
      apiTokenRevoke(token: $token)
    }
  `,

  // ============================================
  // COMMENT MUTATIONS (new commentMutations API)
  // ============================================

  commentCreate: `
    mutation($projectId: String!, $content: JSONObject!, $resourceIdString: String!) {
      commentMutations {
        create(input: {
          projectId: $projectId,
          content: { doc: $content },
          resourceIdString: $resourceIdString
        }) {
          id
          rawText
          authorId
          createdAt
        }
      }
    }
  `,

  commentReply: `
    mutation($projectId: String!, $threadId: String!, $content: JSONObject!) {
      commentMutations {
        reply(input: {
          projectId: $projectId,
          threadId: $threadId,
          content: { doc: $content }
        }) {
          id
          rawText
          authorId
          createdAt
        }
      }
    }
  `,

  commentArchive: `
    mutation($projectId: String!, $commentId: String!, $archived: Boolean!) {
      commentMutations {
        archive(input: { projectId: $projectId, commentId: $commentId, archived: $archived })
      }
    }
  `,

  commentEdit: `
    mutation($projectId: String!, $commentId: String!, $content: JSONObject!) {
      commentMutations {
        edit(input: {
          projectId: $projectId,
          commentId: $commentId,
          content: { doc: $content }
        }) {
          id
          rawText
          authorId
          updatedAt
        }
      }
    }
  `,

  commentMarkViewed: `
    mutation($projectId: String!, $commentId: String!) {
      commentMutations {
        markViewed(input: { projectId: $projectId, commentId: $commentId })
      }
    }
  `,

  // ============================================
  // FILE UPLOAD MUTATIONS
  // ============================================

  generateUploadUrl: `
    mutation($projectId: String!, $fileName: String!) {
      fileUploadMutations {
        generateUploadUrl(input: { projectId: $projectId, fileName: $fileName }) {
          url
          fileId
        }
      }
    }
  `,

  startFileImport: `
    mutation($projectId: String!, $modelId: String!, $fileId: String!, $etag: String!) {
      fileUploadMutations {
        startFileImport(input: { projectId: $projectId, modelId: $modelId, fileId: $fileId, etag: $etag }) {
          id
          fileName
          convertedStatus
          convertedMessage
          uploadComplete
        }
      }
    }
  `,


  // ============================================
  // WEBHOOK MUTATIONS
  // ============================================

  webhookCreate: `
    mutation($streamId: String!, $url: String!, $description: String, $triggers: [String!]!) {
      webhookCreate(webhook: { streamId: $streamId, url: $url, description: $description, triggers: $triggers })
    }
  `,

  webhookDelete: `
    mutation($streamId: String!, $webhookId: String!) {
      webhookDelete(webhook: { streamId: $streamId, id: $webhookId })
    }
  `,

  webhookUpdate: `
    mutation($streamId: String!, $webhookId: String!, $url: String, $description: String, $enabled: Boolean, $triggers: [String!]) {
      webhookUpdate(webhook: { id: $webhookId, streamId: $streamId, url: $url, description: $description, enabled: $enabled, triggers: $triggers })
    }
  `,

};

/**
 * @file deleteUser.js
 * @module deleteUser
 * @description
 * AWS Lambda handler to delete a user from Cognito and DynamoDB,
 * plus purge all their Conversations and Threads entries using the user's ID.
 */


// From github

import { DynamoDBClient, DeleteItemCommand, QueryCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const REGION                         = process.env.AWS_REGION           || "us-east-2";
const USER_POOL_ID                   = process.env.COGNITO_USER_POOL_ID;
const USERS_TABLE                    = process.env.USERS_TABLE         || "Users";
const CONVERSATIONS_TABLE            = process.env.CONVERSATIONS_TABLE || "Conversations";
const THREADS_TABLE                  = process.env.THREADS_TABLE      || "Threads";
const ID_INDEX                       = "id-index";
const ASSOCIATED_ACCOUNT_INDEX       = "associated_account-is_first_email-index";
const THREADS_ASSOCIATED_INDEX       = "associated_account-index";

if (!USER_POOL_ID) {
  throw new Error("Missing required env var: COGNITO_USER_POOL_ID");
}

const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const dynamoDb      = new DynamoDBClient({ region: REGION });
const lambdaClient  = new LambdaClient({ region: REGION });

async function getCorsHeaders(event) {
  try {
    const res = await lambdaClient.send(new InvokeCommand({
      FunctionName:   "Allow-Cors",
      InvocationType: "RequestResponse",
      Payload:        JSON.stringify(event),
    }));
    const payload = JSON.parse(new TextDecoder().decode(res.Payload));
    return payload.headers;
  } catch {
    return {
      "Access-Control-Allow-Origin":      "*",
      "Access-Control-Allow-Methods":     "OPTIONS, POST",
      "Access-Control-Allow-Headers":     "Content-Type",
      "Access-Control-Allow-Credentials": "true",
    };
  }
}

export const handler = async (event) => {
  const cors = await getCorsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }

  let targetId;
  try {
    const body = JSON.parse(event.body || "{}");
    targetId = body.id;
    if (!targetId) throw new Error("Missing required field: id");
  } catch (err) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ message: `Invalid request: ${err.message}` }),
    };
  }

  try {
    // 1) Get user details to get email for Cognito deletion
    const userResult = await dynamoDb.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: ID_INDEX,
      KeyConditionExpression: "id = :id",
      ExpressionAttributeValues: {
        ":id": { S: targetId },
      },
    }));

    if (!userResult.Items || userResult.Items.length === 0) {
      throw new Error("User not found in database");
    }

    const userEmail = userResult.Items[0].email?.S;
    if (!userEmail) {
      throw new Error("User email not found in user record");
    }

    // 2) Delete from Cognito using email
    await cognitoClient.send(new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: targetId,
    }));

    // 3) Query and delete all Conversations where associated_account = targetId
    const { Items: convItems = [] } = await dynamoDb.send(new QueryCommand({
      TableName: CONVERSATIONS_TABLE,
      IndexName: ASSOCIATED_ACCOUNT_INDEX,
      KeyConditionExpression: "associated_account = :id",
      ExpressionAttributeValues: {
        ":id": { S: targetId },
      },
    }));

    // 4) Query and delete all Threads where associated_accounts = targetId
    const { Items: threadItems = [] } = await dynamoDb.send(new QueryCommand({
      TableName: THREADS_TABLE,
      IndexName: THREADS_ASSOCIATED_INDEX,
      KeyConditionExpression: "associated_accounts = :id",
      ExpressionAttributeValues: {
        ":id": { S: targetId },
      },
    }));

    // 5) Delete all conversations
    const deleteConversationPromises = convItems.map(item =>
      dynamoDb.send(new DeleteItemCommand({
        TableName: CONVERSATIONS_TABLE,
        Key: {
          conversation_id: { S: item.conversation_id.S },
          response_id: { S: item.responseId.S },
        },
      }))
    );

    // 6) Delete all threads
    const deleteThreadPromises = threadItems.map(item =>
      dynamoDb.send(new DeleteItemCommand({
        TableName: THREADS_TABLE,
        Key: {
          thread_id: { S: item.thread_id.S },
          message_id: { S: item.message_id.S },
        },
      }))
    );

    // 7) Wait for all deletions to complete
    await Promise.all([...deleteConversationPromises, ...deleteThreadPromises]);

    // 8) Finally delete the user record using the ID
    await dynamoDb.send(new DeleteItemCommand({
      TableName: USERS_TABLE,
      Key: {
        id: { S: targetId },
      },
    }));

    // 9) Success response
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ 
        message: "User and all associated records successfully deleted",
        deletedCounts: {
          conversations: convItems.length,
          threads: threadItems.length
        }
      }),
    };
  } catch (err) {
    console.error("Deletion error:", err);
    const isNotFound = err.name === "UserNotFoundException";
    return {
      statusCode: isNotFound ? 404 : 500,
      headers: cors,
      body: JSON.stringify({ 
        message: err.message,
        error: err.name
      }),
    };
  }
};

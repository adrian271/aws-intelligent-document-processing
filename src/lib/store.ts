/**
 * DynamoDB persistence.
 *
 * The table has a single partition key `id` plus a fixed `gsi1pk` so we can
 * list every document newest-first without a table scan. For a POC that's the
 * whole data model — one item per document, the extraction result stored
 * inline as a nested document.
 */

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "./aws";
import type { DocumentRecord } from "./types";

/** Every item shares this partition key so the GSI acts as one sorted list. */
const LIST_PK = "DOC";

type StoredDocument = DocumentRecord & { gsi1pk: string; gsi1sk: string };

function toStored(doc: DocumentRecord): StoredDocument {
  return { ...doc, gsi1pk: LIST_PK, gsi1sk: doc.createdAt };
}

function fromStored(item: Record<string, unknown>): DocumentRecord {
  // DynamoDB hands back an untyped bag; the index keys are ours, not the
  // caller's, so strip them on the way out.
  const { gsi1pk: _pk, gsi1sk: _sk, ...doc } = item as unknown as StoredDocument;
  return doc;
}

export async function putDocument(doc: DocumentRecord): Promise<DocumentRecord> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: toStored(doc) }));
  return doc;
}

export async function getDocument(id: string): Promise<DocumentRecord | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id } }));
  return res.Item ? fromStored(res.Item) : null;
}

export async function listDocuments(limit = 50): Promise<DocumentRecord[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "byCreatedAt",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": LIST_PK },
      ScanIndexForward: false, // newest first
      Limit: limit,
    }),
  );
  return (res.Items ?? []).map(fromStored);
}

/**
 * Partial update. Only the keys present in `patch` are written, so two
 * concurrent updates to different fields don't clobber each other.
 */
export async function updateDocument(
  id: string,
  patch: Partial<DocumentRecord>,
): Promise<DocumentRecord | null> {
  const entries = Object.entries({ ...patch, updatedAt: new Date().toISOString() });
  if (entries.length === 0) return getDocument(id);

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];

  entries.forEach(([key, value], i) => {
    names[`#k${i}`] = key;
    values[`:v${i}`] = value;
    sets.push(`#k${i} = :v${i}`);
  });

  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { id },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(id)",
      ReturnValues: "ALL_NEW",
    }),
  );

  return res.Attributes ? fromStored(res.Attributes) : null;
}

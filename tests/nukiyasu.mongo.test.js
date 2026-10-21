import test from "node:test";
import assert from "node:assert/strict";
import { claimDelivery, markDeliveryFailed, markDeliverySent } from "../lib/nukiyasuStore.js";

test("claimDelivery real incrementa intentos y conserva sending/sent", { skip: !process.env.MONGODB_TEST_URI }, async () => {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(process.env.MONGODB_TEST_URI);
  const prefix = `nukiyasu:integration:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const pendingId = `${prefix}:pending`;
  const guildId = `${prefix}:guild`;

  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_TEST_DB_NAME || undefined);
    const collection = db.collection(process.env.MONGODB_TEST_COLLECTION || "btv_test");
    const deliveryId = `nukiyasu:delivery:${pendingId}:${guildId}`;

    try {
      assert.equal(await claimDelivery(collection, pendingId, guildId), true);
      let delivery = await collection.findOne({ _id: deliveryId });
      assert.equal(delivery.status, "sending");
      assert.equal(delivery.attempts, 1);

      assert.equal(await claimDelivery(collection, pendingId, guildId), false);
      await markDeliverySent(collection, pendingId, guildId);

      delivery = await collection.findOne({ _id: deliveryId });
      assert.equal(delivery.status, "sent");
      assert.equal(await claimDelivery(collection, pendingId, guildId), false);

      const retryPendingId = `${prefix}:retry-pending`;
      const retryDeliveryId = `nukiyasu:delivery:${retryPendingId}:${guildId}`;
      assert.equal(await claimDelivery(collection, retryPendingId, guildId), true);
      await markDeliveryFailed(collection, retryPendingId, guildId, new Error("Discord temporal"));
      let retryDelivery = await collection.findOne({ _id: retryDeliveryId });
      assert.equal(retryDelivery.status, "pending");
      assert.match(retryDelivery.lastError, /Discord temporal/);
      assert.equal(await claimDelivery(collection, retryPendingId, guildId, new Date(Date.now() + 61_000)), true);
      retryDelivery = await collection.findOne({ _id: retryDeliveryId });
      assert.equal(retryDelivery.status, "sending");
      assert.equal(retryDelivery.attempts, 2);
      await markDeliverySent(collection, retryPendingId, guildId);
    } finally {
      await collection.deleteOne({ _id: deliveryId });
      await collection.deleteOne({ _id: `nukiyasu:delivery:${prefix}:retry-pending:${guildId}` });
    }
  } finally {
    await client.close();
  }
});

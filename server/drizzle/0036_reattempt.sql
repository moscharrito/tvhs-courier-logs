-- Reattempting a delivery that did not land the first time.
--
-- A REATTEMPT IS A NEW DELIVERY, NOT A REOPENED ONE, and this column is the
-- whole design decision.
--
-- The tempting version is to set a failed order back to 'ready' and send
-- somebody out again. It is wrong for the same reason returns.ts gives for
-- not letting a return change a status: a dry run stays failed and bills as a
-- dry run. Reopening the original would rewrite what happened on Tuesday
-- because of something that happened on Wednesday. The completion rate would
-- move retroactively, the custody chain would contain two deliveries
-- pretending to be one, and an invoice already issued for the first attempt
-- would no longer agree with the record behind it.
--
-- So the second attempt is its own order, with its own SLA clock, its own
-- custody chain and its own line on an invoice, and this column says where it
-- came from. The first attempt keeps its outcome forever.
--
-- NULLABLE AND UNCONSTRAINED BY DEFAULT. Almost every order is not a
-- reattempt, and the foreign key is to orders in the same project; SQLite
-- cannot express "in the same project" in a REFERENCES clause, so the handler
-- checks it and this records it.
--
-- ONE OPEN REATTEMPT AT A TIME. The partial unique index below is the lock: a
-- dispatcher who clicks twice, or two dispatchers working the same failed
-- delivery, produce one second attempt rather than two couriers sent to the
-- same door. It counts only orders that are still open, because a reattempt
-- that itself failed should be reattemptable again.

ALTER TABLE orders ADD COLUMN reattempt_of_order_id INTEGER REFERENCES orders(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS orders_reattempt_of_idx ON orders(reattempt_of_order_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_open_reattempt
    ON orders(reattempt_of_order_id)
    WHERE reattempt_of_order_id IS NOT NULL
      AND status NOT IN ('delivered', 'failed', 'cancelled');

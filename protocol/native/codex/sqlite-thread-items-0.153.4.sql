CREATE TABLE thread_items (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    rollout_ordinal INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '', updated_at_ordinal INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, turn_id, item_id)
)

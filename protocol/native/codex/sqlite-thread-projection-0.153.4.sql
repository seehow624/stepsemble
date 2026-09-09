CREATE TABLE thread_history_projection_state (
    thread_id TEXT PRIMARY KEY,
    next_rollout_byte_offset INTEGER NOT NULL,
    next_rollout_ordinal INTEGER NOT NULL
)

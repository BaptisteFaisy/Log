-- SchÃ©ma Â« historique Â» (base PostgreSQL Aiven : pg-memoire/historique)
-- Source de vÃ©ritÃ© : les logs affichÃ©s sur le site viennent de `logs`,
-- alimentÃ©e par le topic Kafka `otel.logs`.

create table if not exists logs (
  seq            bigserial primary key,
  id             text        not null unique,
  topic          text        not null,
  partition      integer     not null,
  kafka_offset   bigint      not null,
  kafka_key      text,
  code           text        not null,
  severity       text        not null default 'err',
  message        text        not null,
  payload        jsonb       not null default '{}'::jsonb,
  occurred_at    timestamptz not null default now(),
  received_at    timestamptz not null default now(),
  constraint logs_kafka_position unique (topic, partition, kafka_offset)
);

create index if not exists logs_seq_idx on logs (seq);
create index if not exists logs_code_idx on logs (code);
create index if not exists logs_received_idx on logs (received_at desc);

create table if not exists agent_runs (
  run_id        text        primary key,
  fingerprint   text        not null,
  code          text        not null,
  mode          text        not null check (mode in ('cold', 'warm', 'warm_degraded')),
  status        text        not null check (status in ('resolved', 'failed', 'abandoned')),
  started_at    timestamptz not null,
  ended_at      timestamptz,
  duration_ms   integer     not null default 0,
  agent_ms      integer     not null default 0,
  steps         jsonb       not null default '[]'::jsonb,
  tokens        jsonb       not null default '{}'::jsonb,
  tokens_total  integer     not null default 0,
  memo_hit      boolean     not null default false,
  memo_path     text,
  agent         text,
  attempt       integer     not null default 1,
  inserted_at   timestamptz not null default now()
);

create index if not exists agent_runs_fingerprint_idx on agent_runs (fingerprint, started_at);
create index if not exists agent_runs_started_idx on agent_runs (started_at desc);

-- MÃ©thode de rÃ©solution (ex-`.md`) : une ligne par fingerprint d'erreur.
create table if not exists error_resolutions (
  fingerprint   text        primary key,
  code          text        not null,
  cause         text,
  fix           text,
  files         text[]      not null default '{}',
  verification  text,
  tokens_used   integer     not null default 0,
  duration_ms   integer     not null default 0,
  agent         text,
  runs          integer     not null default 1,
  updated_at    timestamptz not null default now()
);

create index if not exists error_resolutions_code_idx on error_resolutions (code);
create index if not exists error_resolutions_updated_idx on error_resolutions (updated_at desc);

-- Curseur de consommation Kafka : garantit une reprise sans doublon
-- et une correspondance stricte offset Kafka â†” ligne affichÃ©e.
create table if not exists kafka_cursors (
  topic       text        not null,
  partition   integer     not null,
  next_offset bigint      not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (topic, partition)
);

-- Recherche de probleme similaire (trigrammes).
create index if not exists error_resolutions_fix_trgm_idx on error_resolutions using gin (fix gin_trgm_ops);
create index if not exists error_resolutions_cause_trgm_idx on error_resolutions using gin (cause gin_trgm_ops);


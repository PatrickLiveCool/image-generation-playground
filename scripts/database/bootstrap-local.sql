\set ON_ERROR_STOP on
-- 只供 bootstrap-local.mjs 已核验的隔离容器使用，不是应用迁移。
SELECT 'CREATE ROLE qintopia_image_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ''synthetic-local-migrator-only'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'qintopia_image_migrator') \gexec
SELECT 'CREATE ROLE qintopia_image_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ''synthetic-local-runtime-only'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'qintopia_image_app') \gexec
SELECT 'CREATE DATABASE qintopia_image OWNER qintopia_image_migrator ENCODING ''UTF8'' CONNECTION LIMIT 20'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'qintopia_image') \gexec
\connect qintopia_image
REVOKE ALL ON DATABASE qintopia_image FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO image_test_root;
GRANT CONNECT ON DATABASE qintopia_image TO qintopia_image_app;
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION qintopia_image_migrator;
GRANT USAGE ON SCHEMA app TO qintopia_image_app;
ALTER ROLE qintopia_image_app IN DATABASE qintopia_image SET search_path = app, pg_catalog;
ALTER ROLE qintopia_image_migrator IN DATABASE qintopia_image SET search_path = app, pg_catalog;
ALTER DEFAULT PRIVILEGES FOR ROLE qintopia_image_migrator IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qintopia_image_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qintopia_image_migrator IN SCHEMA app GRANT USAGE ON SEQUENCES TO qintopia_image_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qintopia_image_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
COMMENT ON DATABASE qintopia_image IS :'fixture_marker';

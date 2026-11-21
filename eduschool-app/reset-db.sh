#!/bin/bash
set -e

echo "Resetting database schema..."
docker-compose exec -T db psql -U postgres -d eduschool -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"

echo "Applying Prisma migrations..."
docker-compose exec -T server npx prisma migrate deploy

echo "Generating Prisma client..."
docker-compose exec -T server npx prisma generate

echo "✓ Database reset complete!"

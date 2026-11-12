Shamdan — School Management Platform

Shamdan is a multi-tenant platform for language schools, bringing scheduling, student and teacher records, attendance, lesson credits, and school operations into one application.

> Portfolio project. This repository is a public presentation copy. Before sharing it with recruiters, publish the project files in browsable form and confirm that the code, sample data, screenshots, and documentation are approved for public release.

## What it does

- **Schedule lessons:** recurring schedules, room and teacher views, and responsive calendar layouts.
- **Manage students and groups:** enrollment, cohort membership, and capacity-aware workflows.
- **Track attendance and lesson credits:** session records and a ledger that makes balance changes traceable.
- **Support school operations:** subscription and finance workflows, summaries, and administrator controls.
- **Protect tenant data:** school-level separation, role-aware access, rate limiting, and authentication options including TOTP and passkeys.
- **Coordinate communications:** notifications and campaigns with audience targeting, scheduling, and delivery history.

## Engineering highlights

- Connected recurring schedule blocks to dated sessions, attendance, and lesson-credit transactions so operational history can be followed.
- Improved schedule usability with room-view zoom, group color cues, shared theme tokens, day headers, and mobile layouts.
- Added data-integrity and operational safeguards across scheduling, finance, authentication, and notification workflows.

## Technology

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS, React Router 7, PWA
- **Backend:** Node.js, Express, TypeScript
- **Database:** PostgreSQL with Prisma ORM
- **Local infrastructure:** Docker Compose
- **Quality:** Jest and Playwright

## Repository contents

The public repository should contain the extracted project source and documentation so visitors can browse the implementation directly. Avoid using a ZIP archive as the only project file. Keep secrets, real customer data, production configuration, and private operational details out of the public copy.

## Getting started

Setup instructions depend on the project files included in this public copy. Add verified prerequisites, environment-variable guidance, database setup, and run commands here after the source tree is published. Never commit real credentials or `.env` files.

## Screenshots or demo

Add a few current screenshots or a short demo link here once you have approved public-facing visuals. Use synthetic data in screenshots.

## Project status

This repository presents a software project for portfolio review. It does not claim production availability or customer usage.

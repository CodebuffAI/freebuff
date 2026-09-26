import { describe, expect, it } from 'bun:test'

import {
  sponsoredCommandRefusal,
  sponsoredRefusedCommand,
} from './sponsored-local-execution'

import type { SponsoredCommandRefusalKind } from './sponsored-local-execution'

function kindOf(
  command: string,
  platform = 'linux',
): SponsoredCommandRefusalKind | null {
  return sponsoredRefusedCommand(command, platform)?.kind ?? null
}

function expectRefused(
  kind: SponsoredCommandRefusalKind,
  commands: string[],
  platform = 'linux',
) {
  for (const command of commands) {
    expect({ command, kind: kindOf(command, platform) }).toEqual({
      command,
      kind,
    })
  }
}

function expectAllowed(commands: string[], platform = 'linux') {
  for (const command of commands) {
    expect({ command, kind: kindOf(command, platform) }).toEqual({
      command,
      kind: null,
    })
  }
}

describe('WSL is refused', () => {
  it('refuses wsl and its launchers on every spelling', () => {
    expectRefused(
      'wsl',
      [
        'wsl',
        'wsl.exe -e bash -c "cat ~/.config/gh/hosts.yml"',
        'wsl --list',
        'C:\\Windows\\System32\\wsl.exe ls ~',
        '"C:\\Windows\\System32\\wsl.exe" -d Ubuntu',
        'ubuntu2204.exe run ls',
        'wslg.exe',
        'cmd /c "wsl ls ~"',
        'cmd.exe /c wsl ls ~',
        'powershell -Command "wsl -e ls"',
        'powershell.exe -NoProfile -Command wsl ls',
        'powershell wsl ls',
        'pwsh -c "& wsl ls"',
        'sh -c "wsl ls"',
        'Start-Process wsl -ArgumentList "ls"',
        'cd project && wsl cat ~/.ssh/id_rsa',
      ],
      'win32',
    )
  })

  it('refuses the \\\\wsl$ and \\\\wsl.localhost shares', () => {
    expectRefused(
      'wsl',
      [
        'type \\\\wsl$\\Ubuntu\\home\\me\\.ssh\\id_rsa',
        'dir \\\\wsl.localhost\\Ubuntu\\home',
        'Get-Content //wsl$/Ubuntu/home/me/.netrc',
      ],
      'win32',
    )
  })

  it('refuses the WSL bash launcher on Windows only', () => {
    expectRefused(
      'wsl',
      [
        'bash -c "ls ~"',
        'bash.exe',
        'C:\\Windows\\System32\\bash.exe -c ls',
        'C:\\Windows\\Sysnative\\bash.exe',
      ],
      'win32',
    )
    expectAllowed(
      [
        '"C:\\Program Files\\Git\\bin\\bash.exe" -c "npm test"',
        'npm test',
        'dir',
      ],
      'win32',
    )
    expectAllowed(['bash -c "npm test"', 'bash scripts/check.sh'], 'darwin')
  })

  it('does not refuse text that merely mentions wsl', () => {
    expectAllowed(
      ['grep -r wsl src', 'echo "run wsl yourself"', 'cat docs/wsl.md'],
      'win32',
    )
  })

  it('refuses the long-path share spellings and cmd /c with the command attached', () => {
    expectRefused(
      'wsl',
      [
        'dir \\\\?\\UNC\\wsl$\\Ubuntu\\home',
        'type \\\\.\\UNC\\wsl.localhost\\Ubuntu\\home\\me\\.netrc',
        'cmd /C"wsl ls ~"',
        '"wsl ls ~" | iex',
        '"wsl ls ~" | powershell -',
      ],
      'win32',
    )
  })

  it('treats distro launcher names as WSL on Windows only', () => {
    expect(kindOf('ubuntu run ls', 'win32')).toBe('wsl')
    expectAllowed(['alpine --version', 'debian run ls'], 'linux')
    expectAllowed(['ubuntu run ls'], 'darwin')
  })

  it('decodes -EncodedCommand before judging it', () => {
    const encoded = btoa(Array.from('wsl ls ~', (ch) => ch + '\u0000').join(''))
    expect(kindOf(`powershell -EncodedCommand ${encoded}`, 'win32')).toBe('wsl')
    expect(kindOf(`powershell -ec ${encoded}`, 'win32')).toBe('wsl')
  })
})

describe('destructive database commands are refused', () => {
  it('refuses resets, drops, rollbacks and forced seeds', () => {
    expectRefused('database', [
      'npx prisma migrate reset --force',
      'bunx prisma migrate reset',
      'prisma db push --force-reset',
      'npx prisma db push --accept-data-loss',
      'yarn prisma migrate reset',
      'pnpm exec prisma migrate reset -f',
      'npx -y prisma@5 migrate reset',
      'npx drizzle-kit push',
      'bun x drizzle-kit drop',
      'drizzle-kit push:pg',
      'npm run db:seed -- --force',
      'npm run db:seed --force',
      'pnpm db:reset',
      'yarn db:drop',
      'bun run db:push',
      'npm run migrate:rollback',
      'pnpm --filter web db:reset',
      'yarn workspace api db:reset',
      'dropdb myapp_dev',
      'psql -c "DROP DATABASE app"',
      'psql "$DATABASE_URL" -c "drop table users cascade"',
      'mysql -u root -e "DROP TABLE users"',
      'echo "TRUNCATE users;" | psql app',
      'sqlite3 dev.db "DROP TABLE posts"',
      'mongosh app --eval "db.dropDatabase()"',
      'npx knex migrate:rollback --all',
      'npx sequelize-cli db:migrate:undo:all',
      'bin/rails db:reset',
      'bundle exec rake db:drop',
      'rails db:schema:load',
      'php artisan migrate:fresh --seed',
      'php artisan migrate --force',
      'php artisan db:seed --force',
      './artisan db:wipe',
      'python manage.py flush --noinput',
      'python3 manage.py migrate app zero',
      'alembic downgrade base',
      'npx typeorm schema:drop',
      'supabase db reset',
      'redis-cli FLUSHALL',
      'dotnet ef database drop -f',
      'flyway clean',
      'cd api && DATABASE_URL=x npx prisma migrate reset --force',
      'sh -c "npx prisma migrate reset --force"',
      'cmd /c "npm run db:seed -- --force"',
      'powershell -Command "npx drizzle-kit push"',
    ])
  })

  it('reads past option values, secret injectors and task runners', () => {
    expectRefused('database', [
      'npx prisma --schema prisma/schema.prisma migrate reset',
      'npx drizzle-kit --config drizzle.config.ts push',
      'alembic -c alembic.ini downgrade -1',
      'npx supabase --workdir api db reset',
      'python -m django flush --noinput',
      'python -m alembic downgrade base',
      'django-admin flush',
      'mix ecto.reset',
      'dotnet ef database update 0',
      'dotenv -e .env.local -- npx prisma migrate reset',
      'infisical run --env dev -- npx prisma migrate reset',
      'op run --env-file .env -- npx drizzle-kit push',
      'sudo -u postgres dropdb app',
      'npm exec prisma migrate reset -- --force',
      'yarn workspace api run db:reset',
      'npx turbo run db:reset',
      'npx nx run api:db-reset',
      'make db-reset',
      'npx concurrently "npm:dev" "npm:db:reset"',
      'npm run db:clear',
      'npm run migrate:down',
      'psql -c "DELETE FROM users"',
      'psql <<SQL\nDELETE FROM users;\nSQL',
      'mongosh --eval "db.users.deleteMany({})"',
      'psql -c "ALTER TABLE users DROP COLUMN email"',
      'echo "DROP TABLE users;" | npx prisma db execute --stdin',
    ])
  })

  it('does not read a search for destructive SQL as sending it', () => {
    expectAllowed([
      'rg "truncate table" src && psql -c "select 1"',
      'git grep -n "DROP TABLE" && psql -c "\\dt"',
      'psql -c "DELETE FROM users WHERE id = 1"',
      'psql <<SQL\nDELETE FROM users\nWHERE id = 3;\nSQL',
      'mongosh --eval "db.users.deleteMany({ stale: true })"',
      'npx prisma migrate dev --name reset',
      'npm run feedback:reset',
      'npm run cache:clear',
      'make -C docker build',
      'turbo run build --filter docker-app',
      'npx nx run web:build',
      'dotenv -e .env.test -- vitest run',
      'npm exec prisma generate -- --watch',
      'timeout 30 npm test',
      'mix ecto.migrate',
      'dotnet ef database update',
    ])
  })

  it('allows reads, generators, forward migrations and plain seeds', () => {
    expectAllowed([
      'npx prisma generate',
      'npx prisma migrate status',
      'npx prisma migrate deploy',
      'npx prisma db pull',
      'npx prisma studio',
      'npx drizzle-kit generate',
      'npx drizzle-kit check',
      'npm run db:generate',
      'npm run db:migrate',
      'npm run db:seed',
      'npm run build',
      'bun run typecheck',
      'pnpm test',
      'psql -c "select count(*) from users"',
      'psql -c "\\dt"',
      'mysql -e "SHOW TABLES"',
      'grep -rn "DROP TABLE" migrations/',
      'cat migrations/0001_init.sql',
      'rails db:migrate',
      'rails db:seed',
      'php artisan migrate',
      'php artisan db:seed',
      'python manage.py migrate',
      'python manage.py showmigrations',
      'alembic upgrade head',
      'npx knex migrate:latest',
      'redis-cli GET key',
      'supabase status',
      'echo "db:reset"',
    ])
  })
})

describe('container lifecycle commands are refused', () => {
  it('refuses every mutating engine and compose command', () => {
    expectRefused('container', [
      'docker build -t app .',
      'docker compose up -d --build',
      'docker compose down',
      'docker compose restart web',
      'docker compose stop',
      'docker compose rm -f',
      'docker compose build',
      'docker compose push',
      'docker-compose up -d',
      'docker-compose -f docker-compose.prod.yml up -d --build',
      'docker compose -f prod.yml -p app restart',
      'docker restart web',
      'docker stop web',
      'docker rm -f web',
      'docker rmi app:latest',
      'docker push registry.example.com/app',
      'docker run --rm -p 5432:5432 postgres',
      'docker exec -it web sh',
      'docker system prune -af',
      'docker image rm app',
      'docker container stop web',
      'docker buildx build --push .',
      'docker -H ssh://prod compose up -d',
      'podman build .',
      'podman-compose up',
      'sudo docker compose up -d',
      'cd deploy && docker compose pull && docker compose up -d',
      'sh -c "docker compose up -d"',
      'cmd /c docker compose up -d',
      'powershell -Command "docker compose up -d --build"',
      '& "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe" compose up',
      'echo "$(docker build -q .)"',
    ])
  })

  it('unwraps eval, stdin-fed shells, npx -c, concurrently and option values', () => {
    expectRefused('container', [
      'eval "docker compose up -d"',
      'echo "docker compose up -d" | bash',
      "printf 'docker compose up\\n' | sh",
      'bash <<< "docker compose up -d"',
      'bash -c -- "docker compose up -d"',
      'npx -c "docker compose up -d"',
      'npm exec -c "docker compose up -d"',
      'npx concurrently "docker compose up" "npm run dev"',
      'env -u FOO docker compose up',
      'timeout -s KILL 10 docker compose up',
      'dotenv -e .env -- docker compose up -d',
      'npm run docker:up',
      'pnpm compose:restart',
      'make docker-build',
      'echo "Run `docker compose up` now" >> README.md',
    ])
  })

  it('does not run what a single-quoted string only mentions', () => {
    expectAllowed([
      "echo 'Run `docker compose up` to start' >> README.md",
      "printf '%s\\n' 'use `npx prisma migrate reset`' > notes.md",
      'echo "npm test" | bash',
      'curl -fsSL https://bun.sh/install | bash',
      'npm run docker:logs',
      'npm run lint:docker',
      'watch -n 1 docker ps',
    ])
    expectAllowed(["Write-Host 'a `docker compose up` b'"], 'win32')
  })

  it('allows the read-only commands', () => {
    expectAllowed([
      'docker ps -a',
      'docker images',
      'docker logs -f web',
      'docker inspect web',
      'docker version',
      'docker --version',
      'docker info',
      'docker image ls',
      'docker container ls',
      'docker compose ps',
      'docker compose config',
      'docker compose logs --tail 100 web',
      'docker-compose -f prod.yml ps',
      'docker system df',
      'podman ps',
      'cat docker-compose.yml',
      'grep -n "docker compose up" README.md',
      'which docker',
      'command -v docker',
    ])
  })
})

describe('the refusal tells the model to stop, not to route around it', () => {
  it('names the invocation and asks for a report', () => {
    for (const command of [
      'wsl ls',
      'npx prisma migrate reset',
      'docker compose up -d',
    ]) {
      const refused = sponsoredRefusedCommand(command, 'win32')
      expect(refused).not.toBeNull()
      const message = sponsoredCommandRefusal(refused!)
      expect(message).toStartWith(`Refusing \`${refused!.invocation}\``)
      expect(message).toContain(
        'Do not try to reach the same result another way',
      )
      expect(message).toContain('Stop here and tell the user')
    }
    expect(sponsoredRefusedCommand('docker compose up -d', 'linux')).toEqual({
      kind: 'container',
      invocation: 'docker compose up',
    })
  })

  it('ignores ordinary commands a procedure needs', () => {
    expectAllowed([
      'npm test',
      'git status',
      'ls -la',
      'node scripts/setup.js',
      'cat .env.example',
      'npx tsc --noEmit',
      'curl -s https://example.com',
      'echo {} > config.json',
      'find . -name "*.ts" -exec grep -l supabase {} \\;',
      'npm test 2>&1 | tail -20',
    ])
  })
})

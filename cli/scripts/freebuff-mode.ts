/**
 * The `FREEBUFF_MODE` literal a CLI build compiles in.
 *
 * `bun build --compile` freezes `process.env.FREEBUFF_MODE` into the artifact,
 * and `IS_FREEBUFF` (`cli/src/utils/constants.ts`) is `=== 'true'` on it. The
 * define used to default to 'false', so a `freebuff` binary built without the
 * variable (the `workflow_dispatch` path of `cli-release-build.yml` did exactly
 * that) compiled as the Codebuff client under the free name, and nothing
 * failed. The free artifact now refuses to build unless it is the free build.
 */
export function freebuffModeDefine(
  binaryName: string,
  env: Record<string, string | undefined>,
): 'true' | 'false' {
  const isFree = env.FREEBUFF_MODE === 'true'
  if (binaryName === 'freebuff' && !isFree) {
    throw new Error(
      `Refusing to build freebuff with FREEBUFF_MODE=${env.FREEBUFF_MODE ?? '(unset)'}: ` +
        'it would compile as the Codebuff client. Set FREEBUFF_MODE=true.',
    )
  }
  return isFree ? 'true' : 'false'
}

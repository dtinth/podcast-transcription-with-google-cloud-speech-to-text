const { spawnSync, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const lang = process.env.GCLOUD_ML_SPEECH_LANG || 'th'

function die(message) {
  console.error(message)
  process.exit(1)
}

if (!process.argv[2]) {
  die('FAIL: No input file specified. Please specify an input file.')
}

const inputFile = fs.realpathSync(process.argv[2])

if (path.extname(inputFile) !== '.mp3') {
  die('FAIL: Expected an input file to be .mp3 file.')
}

if (!fs.existsSync(inputFile)) {
  die('FAIL: The input file does not exist.')
}

const inputDirname = path.dirname(inputFile)
const inputExtname = path.extname(inputFile)
const inputBasename = path.basename(inputFile, inputExtname)
const wavFile = path.join(inputDirname, inputBasename + '.wav')
const opusFile = path.join(inputDirname, inputBasename + '.opus')
const jsonFile = path.join(inputDirname, inputBasename + '.json')

if (!process.env.GOOGLE_CLOUD_PROJECT) {
  die('FAIL: No GOOGLE_CLOUD_PROJECT environment variable set\nHOW TO FIX - Run this and try again:\n  gcloud config set project <project-id>')
}

if (!process.env.GS_BUCKET) {
  die('FAIL: No GS_BUCKET environment variable set\nHOW TO FIX - Run this and try again:\n  export GS_BUCKET=<bucket>')
}

const gsBucket = process.env.GS_BUCKET
const gsOpusFile = `gs://${gsBucket}/${inputBasename}.opus`
const gsJsonFile = `gs://${gsBucket}/${inputBasename}.json`

function executeFile(purpose, cmd, args, capture = false) {
  console.log(`\n* ${purpose}\n    $ ${cmd} ${args.map(x => `'${x}'`).join(' ')}`)
  return execFileSync(cmd, args, { stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf-8' })
}

function tryExecuteShell(purpose, cmd, capture = false) {
  console.log(`\n* ${purpose}\n    $ ${cmd}`)
  return spawnSync(cmd, { shell: true, stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'] })
}

function isSuccessful(result) {
  return result.status === 0
}

function assertSuccessful(result) {
  if (!isSuccessful(result)) {
    throw new Error('Latest command execution failed: Exit status = ' + result.status)
  }
}

assertSuccessful(tryExecuteShell('Verify that gcloud is installed', 'which gcloud'))
assertSuccessful(tryExecuteShell('Verify that gsutil is installed', 'which gsutil'))

if (
  !isSuccessful(tryExecuteShell('Check if SoX is installed', 'which sox')) ||
  !isSuccessful(tryExecuteShell('Check if opusenc is installed', 'which opusenc'))
) {
  assertSuccessful(tryExecuteShell('Install required dependencies', 'sudo apt-get install -y sox libsox-fmt-mp3 opus-tools'))
  assertSuccessful(tryExecuteShell('Verify that SoX is installed', 'which sox'))
  assertSuccessful(tryExecuteShell('Verify that opusenc is installed', 'which opusenc'))
}

process.env.PYTHONIOENCODING = 'UTF-8'

if (!fs.existsSync(opusFile)) {
  executeFile('Convert .mp3 to .wav', 'sox', [inputFile, '--channels=1', '--rate=48000', wavFile])
  executeFile('Convert .wav to .opus', 'opusenc', [wavFile, opusFile])
}

executeFile('Upload .opus file to storage', 'gsutil', ['cp', opusFile, gsOpusFile])
const result = JSON.parse(executeFile('Request a transcription', 'gcloud', ['ml', 'speech', 'recognize-long-running', gsOpusFile, `--language-code=${lang}`, '--include-word-time-offsets', '--encoding=ogg-opus', '--sample-rate=48000', '--async'], true))

const operationId = result.name
console.log('=> Operation', result.name)

assertSuccessful(tryExecuteShell('Retrieve result', `gcloud ml speech operations wait '${operationId}' | tee '${jsonFile}'`))
executeFile('Upload .json file to storage', 'gsutil', ['cp', jsonFile, gsJsonFile])
tryExecuteShell('Download file from Cloud Shell', `cloudshell dl '${jsonFile}'`)

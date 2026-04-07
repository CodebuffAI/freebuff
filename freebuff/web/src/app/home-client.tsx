'use client'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Check,
  ChevronDown,
  Copy,
} from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import posthog from 'posthog-js'
import { useMemo, useState } from 'react'

import { BackgroundBeams } from '@/components/background-beams'
import { CopyButton } from '@/components/copy-button'
import { HeroGrid } from '@/components/hero-grid'
import { Icons } from '@/components/icons'
import { cn } from '@/lib/utils'

const INSTALL_COMMAND = 'npm install -g freebuff'

const headlineWords = ["The", "free", "coding", "agent"]

const faqs = [
  {
    question: 'How can it be free?',
    answer:
      'Freebuff is supported by text ads shown in the CLI.',
  },
  {
    question: 'What models do you use?',
    answer:
      'MiniMax M2.7 as the main coding agent. Gemini 3.1 Flash Lite for finding files and research.\n\nConnect your ChatGPT subscription to unlock GPT-5.4 for deep thinking.',
  },
  {
    question: 'Which countries is Freebuff available in?',
    answer:
      'Freebuff is currently available in:\n\nUnited States, Canada, United Kingdom, Australia, New Zealand, Norway, Sweden, Netherlands, Denmark, Germany, Finland, Belgium, Luxembourg, Switzerland, Ireland, and Iceland.',
  },
  {
    question: 'Are you training on my data?',
    answer:
      'No. We do not share your data with third parties that would train on it or use it for another purpose.\n\nIn the future, we may use request data to train custom models to improve Freebuff — this will be opt-out, so you\'ll always have control.',
  },
  {
    question: 'What data do you store?',
    answer:
      "We don't store your codebase. We only collect minimal logs for debugging purposes.",
  },
  {
    question: 'What else is cool in Freebuff?',
    answer:
      `Freebuff comes with 9 specialized subagents:
- file-picker finds relevant files across your codebase
- code-reviewer gives critical feedback on your changes
- browser-use lets the AI control a real browser to test your app
- thinker-gpt does deep reasoning (connect your ChatGPT subscription)
- and more.

After every response, it generates 3 clickable follow-up suggestions so you always know what to do next.

For big tasks, try the commands /interview → /plan → (implement) → /review to go from idea to polished code.`,
  },
]

const setupSteps = [
  {
    label: 'Open your terminal',
    description: 'Use any terminal — within VS Code, plain terminal, PowerShell, etc.',
  },
  {
    label: 'Navigate to your project',
    command: 'cd /path/to/your-repo',
  },
  {
    label: 'Install Freebuff',
    command: 'npm install -g freebuff',
  },
  {
    label: 'Run Freebuff',
    command: 'freebuff',
  },
]

function SetupGuide() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="max-w-md mx-auto">
      <button
        onClick={() => {
          if (!isOpen) {
            posthog.capture(
              AnalyticsEvent.FREEBUFF_HOME_INSTALL_GUIDE_EXPANDED,
            )
          }
          setIsOpen(!isOpen)
        }}
        aria-expanded={isOpen}
        className="flex items-center gap-2 mx-auto text-sm text-zinc-400 hover:text-acid-matrix transition-colors duration-200 cursor-pointer group"
      >
        <span>Install guide</span>
        <motion.span
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.25 }}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="mt-4 bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 text-left">
              <ol className="space-y-4">
                {setupSteps.map((step, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-acid-matrix/10 border border-acid-matrix/30 flex items-center justify-center text-xs font-mono text-acid-matrix">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white/90">{step.label}</p>
                      {'description' in step && step.description && (
                        <p className="text-xs text-zinc-500 mt-0.5">{step.description}</p>
                      )}
                      {'command' in step && step.command && (
                        <div className="mt-1.5 flex items-center gap-2 bg-zinc-800/60 border border-zinc-700/40 rounded-md px-3 py-1.5 hover:border-acid-matrix/30 transition-colors duration-200">
                          <code className="font-mono text-xs text-white/80 flex-1 select-all">
                            {step.command}
                          </code>
                          <CopyButton value={step.command} />
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const PARTICLE_COUNT = 14

function InstallCommand({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false)
  const [copyCount, setCopyCount] = useState(0)

  const particles = useMemo(() =>
    Array.from({ length: PARTICLE_COUNT }).map((_, i) => ({
      angle: (i / PARTICLE_COUNT) * 360 + (Math.random() - 0.5) * 25,
      distance: 35 + Math.random() * 35,
      size: 3 + Math.random() * 4,
      durationExtra: Math.random() * 0.3,
    })),
    [copyCount],
  )

  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALL_COMMAND)
    setCopied(true)
    setCopyCount(c => c + 1)
    posthog.capture(AnalyticsEvent.FREEBUFF_HOME_INSTALL_COMMAND_COPIED)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="relative">
      <div
        className={cn(
          'flex items-center gap-2 bg-zinc-900/80 border rounded-lg px-4 py-3 font-mono text-sm',
          'gradient-border-shine',
          copied
            ? 'border-acid-matrix shadow-[0_0_30px_rgba(124,255,63,0.45),0_0_60px_rgba(124,255,63,0.2)]'
            : 'border-acid-matrix/60 install-box-glow hover:border-acid-matrix hover:shadow-[0_0_30px_rgba(124,255,63,0.35),0_0_60px_rgba(124,255,63,0.15)]',
          'transition-all duration-300',
          className,
        )}
      >
        <span className="text-acid-matrix select-none">$</span>
        <code className="text-white/90 select-all flex-1">
          {INSTALL_COMMAND}
        </code>
        <button
          onClick={handleCopy}
          className="p-1.5 rounded-md transition-colors hover:bg-white/10 cursor-pointer"
          aria-label={`Copy: ${INSTALL_COMMAND}`}
        >
          <AnimatePresence mode="wait" initial={false}>
            {copied ? (
              <motion.span
                key="check"
                initial={{ scale: 0, rotate: -90 }}
                animate={{ scale: 1, rotate: 0 }}
                exit={{ scale: 0, rotate: 90 }}
                transition={{ duration: 0.2 }}
                className="block"
              >
                <Check className="h-4 w-4 text-acid-matrix" />
              </motion.span>
            ) : (
              <motion.span
                key="copy"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0 }}
                transition={{ duration: 0.15 }}
                className="block"
              >
                <Copy className="h-4 w-4 text-white/60" />
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </div>

      {/* Celebration particles */}
      <AnimatePresence>
        {copied &&
          particles.map((p, i) => {
            const rad = (p.angle * Math.PI) / 180
            return (
              <motion.span
                key={i}
                initial={{ opacity: 1, scale: 1, x: 0, y: 0 }}
                animate={{
                  opacity: 0,
                  scale: 0,
                  x: Math.cos(rad) * p.distance,
                  y: Math.sin(rad) * p.distance,
                }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5 + p.durationExtra, ease: 'easeOut' }}
                className="absolute right-5 top-1/2 rounded-full pointer-events-none"
                style={{
                  width: p.size,
                  height: p.size,
                  backgroundColor:
                    i % 3 === 0 ? '#7CFF3F' : i % 3 === 1 ? '#a8ff7a' : '#ffffff',
                }}
              />
            )
          })}
      </AnimatePresence>
    </div>
  )
}

function FAQList() {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  return (
    <div className="divide-y divide-zinc-800/60">
      {faqs.map((faq, i) => {
        const isOpen = openIndex === i
        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, filter: 'blur(8px)', x: 20 }}
            whileInView={{ opacity: 1, filter: 'blur(0px)', x: 0 }}
            viewport={{ once: true, amount: 0.5 }}
            transition={{ duration: 0.5, delay: i * 0.1 }}
            className={cn(
              'transition-all duration-300',
              isOpen && 'bg-acid-matrix/[0.03]',
            )}
          >
            <button
              onClick={() => {
                if (!isOpen) {
                  posthog.capture(
                    AnalyticsEvent.FREEBUFF_HOME_FAQ_OPENED,
                    { question: faq.question },
                  )
                }
                setOpenIndex(isOpen ? null : i)
              }}
              className="w-full flex items-center gap-4 px-4 py-5 text-left transition-all duration-300 cursor-pointer group"
            >
              <span
                className={cn(
                  'flex-shrink-0 font-mono text-xs transition-colors duration-300',
                  isOpen ? 'text-acid-matrix' : 'text-zinc-600 group-hover:text-zinc-400',
                )}
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              <span
                className={cn(
                  'font-semibold flex-1 transition-colors duration-300',
                  isOpen ? 'text-white' : 'text-zinc-300 group-hover:text-white',
                )}
              >
                {faq.question}
              </span>
              <motion.span
                animate={{ rotate: isOpen ? 180 : 0 }}
                transition={{ duration: 0.25 }}
                className={cn(
                  'flex-shrink-0 transition-colors duration-300',
                  isOpen ? 'text-acid-matrix' : 'text-zinc-600',
                )}
              >
                <ChevronDown className="h-4 w-4" />
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <div className="flex gap-4 px-4 pb-5">
                    <span className="flex-shrink-0 w-[1.5ch]"></span>
                    <div className="border-l-2 border-acid-matrix/40 pl-4">
                      <p className="text-zinc-300 leading-relaxed text-sm whitespace-pre-line">
                        {faq.answer}
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )
      })}
    </div>
  )
}

const PHILOSOPHY_WORDS = [
  { word: 'SIMPLE', description: 'No modes. No config. Just works.' },
  { word: 'FAST', description: '5–10× speed up via fast models and quick context gathering.' },
  { word: 'LOADED', description: '9 specialized subagents: code review, browser use, deep thinking with your ChatGPT subscription, and more.' },
]

function PhilosophySection() {
  const [litWords, setLitWords] = useState<Set<number>>(new Set())

  const lightUp = (i: number) => {
    setLitWords(prev => {
      const next = new Set(prev)
      next.add(i)
      return next
    })
  }

  const dimDown = (i: number) => {
    setLitWords(prev => {
      const next = new Set(prev)
      next.delete(i)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-12 md:gap-16">
      {PHILOSOPHY_WORDS.map((item, i) => (
        <motion.div
          key={item.word}
          initial={{ opacity: 0, filter: 'blur(12px)' }}
          whileInView={{ opacity: 1, filter: 'blur(0px)' }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.7, delay: i * 0.1 }}
          className="group"
        >
          <motion.div
            onViewportEnter={() => lightUp(i)}
            onViewportLeave={() => dimDown(i)}
            viewport={{ margin: '0px 0px -50% 0px' }}
            className={cn(
              'font-dm-mono text-7xl md:text-[8rem] lg:text-[6rem] xl:text-[8rem] font-medium leading-[0.85] tracking-tighter select-none transition-all duration-500',
              litWords.has(i) ? 'keyword-filled' : 'keyword-hollow',
            )}
          >
            {item.word}
          </motion.div>
          <p className="mt-3 md:mt-4 text-zinc-400 text-sm md:text-base font-mono tracking-wide">
            {item.description}
          </p>
        </motion.div>
      ))}
    </div>
  )
}

const wordVariant = {
  initial: { opacity: 0, y: 30, filter: 'blur(8px)' },
  animate: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: {
      duration: 0.6,
      ease: [0.165, 0.84, 0.44, 1],
    },
  },
}

export default function HomeClient() {
  return (
    <div className="relative">
      {/* ─── Hero + Philosophy: unified section ─── */}
      <div className="relative overflow-hidden">
        {/* Shared layered backgrounds */}
        <div className="absolute inset-0 bg-gradient-to-b from-dark-forest-green via-black/95 to-black" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(124,255,63,0.12),transparent_50%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_40%_at_50%_65%,rgba(124,255,63,0.06),transparent_50%)]" />

        <HeroGrid />
        <BackgroundBeams />

        {/* Inline nav overlay */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="absolute top-0 left-0 right-0 z-20 container mx-auto px-4 py-4 flex justify-between items-center"
        >
          <Link
            href="/"
            className="flex items-center space-x-2 group transition-all duration-300 hover:translate-x-0.5"
          >
            <Image
              src="/logo-icon.png"
              alt="Freebuff"
              width={28}
              height={28}
              className="rounded-sm opacity-60 group-hover:opacity-100 transition-all duration-300 group-hover:brightness-110"
            />
            <span className="text-xl tracking-widest font-serif text-zinc-400 group-hover:text-white transition-colors duration-200">
              freebuff
            </span>
          </Link>

          <nav className="flex items-center space-x-1">
            <Link
              href="https://github.com/CodebuffAI/codebuff"
              target="_blank"
              rel="noopener noreferrer"
              className="relative font-medium px-3 py-2 rounded-md transition-all duration-200 text-zinc-400 hover:text-white flex items-center gap-2 text-sm"
              onClick={() =>
                posthog.capture(AnalyticsEvent.FREEBUFF_HOME_GITHUB_CLICKED)
              }
            >
              <Icons.github className="h-4 w-4" />
              <span className="hidden sm:inline">GitHub</span>
            </Link>
          </nav>
        </motion.div>

        {/* Hero content */}
        <div className="relative z-10 container mx-auto px-4 pt-32 pb-16 md:pt-40 md:pb-20 text-center min-h-screen flex flex-col items-center justify-center">
          {/* Headline with staggered word animation */}
          <motion.h1
            className="hero-heading mb-8"
            variants={{
              animate: {
                transition: { staggerChildren: 0.08, delayChildren: 0.3 },
              },
            }}
            initial="initial"
            animate="animate"
          >
            <span className="block">
              {headlineWords.map((word, i) => (
                <motion.span
                  key={i}
                  variants={wordVariant}
                  className={word === 'free' ? 'inline-block mr-[0.3em] text-acid-matrix neon-text animate-glow-pulse cursor-default hover-glow-flare' : 'inline-block mr-[0.3em] text-white'}
                >
                  {word}
                </motion.span>
              ))}
            </span>
          </motion.h1>

          {/* Subheadline */}
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.8 }}
            className="text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed"
          >
            No subscription. No configuration. Start in seconds.
          </motion.p>

          {/* Install command */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 1.0 }}
            className="max-w-lg w-full mx-auto mb-4"
          >
            <InstallCommand />
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 1.3 }}
            className="mb-8"
          >
            <SetupGuide />
          </motion.div>
        </div>

        {/* ─── Philosophy + FAQ: side-by-side on large screens ─── */}
        <div className="relative z-10 container mx-auto max-w-7xl px-4 pt-16 md:pt-24 pb-24 md:pb-32 lg:pb-[25vh]">
          <div className="flex flex-col lg:flex-row lg:gap-16 xl:gap-24">
            {/* Philosophy — left side */}
            <div className="lg:flex-1 min-w-0">
              <PhilosophySection />
            </div>

            {/* FAQ — right side (sticky on lg) */}
            <div className="lg:flex-1 min-w-0 mt-20 lg:mt-0 lg:sticky lg:top-24 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.3 }}
                transition={{ duration: 0.6 }}
                className="text-center lg:text-left mb-12"
              >
                <h2 className="text-3xl md:text-4xl font-bold mb-4">
                  FAQ
                </h2>
              </motion.div>

              <FAQList />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

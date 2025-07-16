import { stdin as input, stdout as output } from 'process'
import * as readline from 'readline/promises'
import { chatStream } from './chat'
import { traderPrompt } from './prompts/trader'

async function main() {
  const mcpServers = {
    servers: {
      binance: {
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', 'tsx', './src/mcpServers/binance.ts']
      }
    }
  }

  const systemPrompt = traderPrompt

  const rl = readline.createInterface({ input, output })
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []

  console.log('Trading Assistant REPL')
  console.log('Type "exit" or "quit" to end the session')
  console.log('Type "clear" to clear the conversation history')
  console.log('----------------------------------------\n')

  while (true) {
    const userInput = await rl.question('You: ')

    if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
      console.log('\nGoodbye!')
      break
    }

    if (userInput.toLowerCase() === 'clear') {
      messages.length = 0
      console.log('\nConversation history cleared.\n')
      continue
    }

    messages.push({ role: 'user', content: userInput })

    process.stdout.write('\nAssistant: ')
    let assistantResponse = ''

    try {
      for await (const chunk of chatStream({ systemPrompt, messages, mcpServers })) {
        process.stdout.write(chunk)
        assistantResponse += chunk
      }

      messages.push({ role: 'assistant', content: assistantResponse })
      console.log('\n')
    } catch (error) {
      console.error('\nError:', error)
      messages.pop() // Remove the failed user message
    }
  }

  rl.close()
}

// Handle errors and run main function
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}

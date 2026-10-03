import sys
import asyncio
import edge_tts

async def main():
    if len(sys.argv) < 4:
        print("Usage: ttsWorker.py <text> <voice> <outfile>", file=sys.stderr)
        sys.exit(1)
    text = sys.argv[1]
    voice = sys.argv[2]
    out_file = sys.argv[3]
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(out_file)

if __name__ == '__main__':
    asyncio.run(main())

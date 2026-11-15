import uvicorn

from .config.settings import Settings

if __name__ == "__main__":
    s = Settings()
    uvicorn.run("backend.main:app", host=s.host, port=s.port)

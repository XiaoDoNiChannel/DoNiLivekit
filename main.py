"""Compatibility entry point for existing ``python main.py`` deployments."""

from server.app import app, run_server

__all__ = ["app", "run_server"]


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()
    run_server()

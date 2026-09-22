"""DoNiChannel FastAPI backend package.

Import ``server.app`` explicitly when the ASGI application is required. Keeping
the package initializer side-effect free lets migration and repository tests
run without constructing the web application.
"""

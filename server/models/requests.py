"""Compatibility-preserving Pydantic request models."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class CompatibleModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class RoomAction(CompatibleModel):
    action: str = "create_channel"
    name: str = ""


class ProfileUpdate(CompatibleModel):
    user_id: str = Field(default="", alias="userId")
    identity: str = ""
    display_name: str = Field(default="未命名用户", alias="displayName")
    avatar_color: str = Field(default="#5865f2", alias="avatarColor")
    avatar_preset: str = Field(default="", alias="avatarPreset")
    avatar_url: str = Field(default="", alias="avatarUrl")
    status_text: str = Field(default="在线", alias="statusText")

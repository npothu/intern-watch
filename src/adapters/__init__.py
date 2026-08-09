from .ats_boards import AtsBoardsAdapter
from .base import Adapter
from .jobright_md import JobrightMdAdapter
from .simplify_json import SimplifyJsonAdapter
from .speedyapply_md import SpeedyApplyMdAdapter
from .vanshb03_md import Vanshb03MdAdapter

REGISTRY: dict[str, type[Adapter]] = {
    "simplify_json": SimplifyJsonAdapter,
    "jobright_md": JobrightMdAdapter,
    "vanshb03_md": Vanshb03MdAdapter,
    "speedyapply_md": SpeedyApplyMdAdapter,
    "ats_boards": AtsBoardsAdapter,
}


def make_adapter(cfg) -> Adapter:
    try:
        return REGISTRY[cfg.adapter](cfg)
    except KeyError:
        # `from None`: the KeyError is an implementation detail of the registry
        # lookup and only adds noise above the actionable message.
        raise ValueError(
            f"unknown adapter '{cfg.adapter}' for source '{cfg.name}'") from None

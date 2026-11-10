import logging
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from threading import Event
from collections.abc import Callable


log = logging.getLogger(__name__)


def run_workers(role: str, count: int, stop: Event, work: Callable[[], None]):
    """Stop the pool if any worker exits; propagate unexpected worker failures."""
    log.info("worker_pool_started role=%s workers=%s", role, count)
    with ThreadPoolExecutor(max_workers=count, thread_name_prefix=role) as executor:
        futures = []
        try:
            for _ in range(count):
                futures.append(executor.submit(work))
            done, _ = wait(futures, return_when=FIRST_COMPLETED)
            for future in done:
                future.result()
            if not stop.is_set():
                raise RuntimeError(f"{role} worker exited before shutdown")
        finally:
            stop.set()
        for future in futures:
            future.result()

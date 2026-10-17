"""Create a relocatable shell link using Windows' own IShellLink implementation."""
import ctypes
from pathlib import Path
import os
import uuid

def create_portable_shortcut(path):
    if os.name != 'nt':
        raise RuntimeError('Creating a Windows shortcut requires Windows')
    ole = ctypes.OleDLL('ole32')
    pointer = ctypes.c_void_p
    ole.CoInitializeEx.argtypes = [pointer, ctypes.c_uint32]
    ole.CoInitializeEx.restype = ctypes.c_long
    ole.CoCreateInstance.argtypes = [pointer, pointer, ctypes.c_uint32, pointer, ctypes.POINTER(pointer)]
    ole.CoCreateInstance.restype = ctypes.c_long
    def guid(value):
        return (ctypes.c_ubyte*16).from_buffer_copy(uuid.UUID(value).bytes_le)
    def check(result):
        if result < 0:
            raise OSError(f'Windows COM error 0x{result & 0xffffffff:08x}')
    def call(obj, index, types, *args):
        table=ctypes.cast(obj,ctypes.POINTER(ctypes.POINTER(pointer))).contents
        method=ctypes.WINFUNCTYPE(ctypes.c_long,pointer,*types)(table[index])
        return method(obj,*args)
    check(ole.CoInitializeEx(None,2))
    link=pointer();persist=pointer()
    try:
        clsid=guid('00021401-0000-0000-c000-000000000046')
        iid=guid('000214f9-0000-0000-c000-000000000046')
        check(ole.CoCreateInstance(ctypes.byref(clsid),None,1,ctypes.byref(iid),ctypes.byref(link)))
        # Generic nonexistent fallback: no build-machine path or user identity is stored.
        check(call(link,20,[ctypes.c_wchar_p],r'C:\GrubakaVideoEditor\app\Grubaka Video Editor.exe'))
        check(call(link,18,[ctypes.c_wchar_p,ctypes.c_uint32],r'C:\GrubakaVideoEditor\Start Grubaka Video Editor.lnk',0))
        persist_iid=guid('0000010b-0000-0000-c000-000000000046')
        check(call(link,0,[pointer,ctypes.POINTER(pointer)],ctypes.byref(persist_iid),ctypes.byref(persist)))
        check(call(persist,6,[ctypes.c_wchar_p,ctypes.c_int],str(Path(path).resolve()),1))
    finally:
        if persist.value:call(persist,2,[])
        if link.value:call(link,2,[])
        ole.CoUninitialize()

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('path',type=Path)
    create_portable_shortcut(parser.parse_args().path)

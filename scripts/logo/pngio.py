import zlib, struct

def load(p):
    d=open(p,'rb').read(); pos=8; idat=b''
    while pos < len(d):
        ln=struct.unpack('>I',d[pos:pos+4])[0]; typ=d[pos+4:pos+8]
        if typ==b'IHDR': w,h,bd,ct = struct.unpack('>IIBB', d[pos+8:pos+18])
        if typ==b'IDAT': idat+=d[pos+8:pos+8+ln]
        pos += 12+ln
    raw=zlib.decompress(idat); ch=4; stride=w*ch
    prev=bytearray(stride); rows=[]; i=0
    for y in range(h):
        f=raw[i]; i+=1
        line=bytearray(raw[i:i+stride]); i+=stride
        for x in range(stride):
            a = line[x-ch] if x>=ch else 0
            b = prev[x]; c = prev[x-ch] if x>=ch else 0
            if f==1: line[x]=(line[x]+a)&255
            elif f==2: line[x]=(line[x]+b)&255
            elif f==3: line[x]=(line[x]+((a+b)>>1))&255
            elif f==4:
                pa=abs(b-c); pb=abs(a-c); pc=abs(a+b-2*c)
                pr = a if (pa<=pb and pa<=pc) else (b if pb<=pc else c)
                line[x]=(line[x]+pr)&255
        rows.append(bytes(line)); prev=line
    return w,h,rows

def save(path, w, h, rows):
    raw=b''.join(b'\x00'+bytes(r) for r in rows)
    def chunk(t,data):
        c=struct.pack('>I',len(data))+t+data
        return c+struct.pack('>I', zlib.crc32(t+data)&0xffffffff)
    png=b'\x89PNG\r\n\x1a\n'
    png+=chunk(b'IHDR', struct.pack('>IIBBBBB', w,h,8,6,0,0,0))
    png+=chunk(b'IDAT', zlib.compress(raw,9))
    png+=chunk(b'IEND', b'')
    open(path,'wb').write(png)

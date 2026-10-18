import json,socket,sys
host,port=sys.argv[1],int(sys.argv[2])
for login in sys.argv[3:]:
    s=socket.create_connection((host,port),timeout=10); f=s.makefile("rb")
    s.sendall((json.dumps({"id":1,"jsonrpc":"2.0","method":"eth_submitLogin","params":[login]})+"\n").encode())
    r=json.loads(f.readline()); out={"login":login,"login_reply":r.get("result"),"err":r.get("error")}
    if r.get("result"):
        s.sendall((json.dumps({"id":2,"jsonrpc":"2.0","method":"eth_getWork","params":[]})+"\n").encode())
        w=json.loads(f.readline()); out["work"]=w.get("result")
    print(json.dumps(out)); s.close()
